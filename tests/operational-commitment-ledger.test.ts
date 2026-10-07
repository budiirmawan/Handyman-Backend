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
import { operationalCommitmentService } from '../src/modules/operational-finance';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Commitment Ledger + Concurrency Control.
 *
 * Covers the ledger model, the deterministic lifecycle, budget-row locking,
 * overspend rejection/override, the separate override permission, idempotency,
 * and the no-double-counting foundation. Material/vendor source integration
 * and the variance read model belong to later PARTs and are not exercised.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55493;
const EMBEDDED_DIR = '/tmp/asentra-comm-var-part02-pg';
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

let periodCursor = 0;
function nextPeriod() {
  // Distinct, non-overlapping months keep the existing live-period exclusion
  // constraint satisfied across fixtures.
  periodCursor += 1;
  const month = String((periodCursor % 12) + 1).padStart(2, '0');
  const year = 2030 + Math.floor(periodCursor / 12);
  return { start: `${year}-${month}-01`, end: `${year}-${month}-28` };
}

/** Creates an ACTIVE budget with one category carrying the whole plan. */
async function activeBudget(
  plannedAmount = 1000000,
  overspendPolicy: 'STRICT' | 'ALLOW_WITH_OVERRIDE' = 'STRICT',
) {
  const fixture = await structure();
  const budget = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
    .set(auth())
    .send({
      budgetPeriod: nextPeriod(),
      currency: 'IDR',
      plannedAmount,
      overspendPolicy,
    });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));

  const category = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({ code: 'MAINTENANCE', name: 'Maintenance', plannedAmount });
  assert.equal(category.status, 201, JSON.stringify(category.body));

  const activated = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  return {
    ...fixture,
    budgetId: budget.body.data.id as string,
    categoryId: category.body.data.id as string,
  };
}

function commitmentPayload(
  categoryId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    budgetCategoryId: categoryId,
    title: 'Chiller overhaul retainer',
    amount: 400000,
    currency: 'IDR',
    reason: 'Approved obligation with no priced source authority yet.',
    idempotencyKey: key(),
    ...extra,
  };
}

async function commit(
  budgetId: string,
  payload: Record<string, unknown>,
  actorToken = token,
) {
  return api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments`)
    .set(auth(actorToken))
    .send(payload);
}

async function events(entityId: string, eventType: string) {
  const result = await pool!.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM operational_events
      WHERE entity_id = $1 AND event_type = $2
      ORDER BY created_at`,
    [entityId, eventType],
  );
  return result.rows;
}

/** Grants the separate override authority to an existing user. */
async function grantOverride(targetUserId: string): Promise<void> {
  const existing = await permissionRepository.findByCode(
    'operational_budget.override',
  );
  const permissionId =
    existing?.id ??
    (
      await permissionService.createPermission({
        code: 'operational_budget.override',
        name: 'Override Operational Budget Overspend',
      })
    ).id;
  const role = await roleService.createRole({
    code: `OVERRIDE_${suffix()}`,
    name: 'Budget Override',
  });
  await permissionService.assignPermissionToRole(role.id, permissionId);
  await roleService.assignRoleToUser(targetUserId, role.id);
}

describe('CR-BE-COMM-VAR-01 PART 02 — Commitment ledger + concurrency control', () => {
  it('creates a commitment with an immutable CREATE ledger entry', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();
    const created = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const body = created.body.data;
    assert.equal(body.status, 'COMMITTED');
    assert.equal(body.origin, 'MANUAL');
    assert.equal(body.sourceType, null);
    assert.equal(body.currency, 'IDR');
    assert.equal(body.committedAmount, 400000);
    assert.equal(body.actualizedAmount, 0);
    assert.equal(body.releasedAmount, 0);
    assert.equal(body.openAmount, 400000);
    assert.equal(body.overspendOverride, null);
    assert.equal(body.clientId, fixture.client.id);
    assert.equal(body.buildingId, fixture.building.id);

    const detail = await api()
      .get(`/api/v1/operational-commitments/${body.id}`)
      .set(auth());
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.entries.length, 1);
    assert.equal(detail.body.data.entries[0].entryType, 'CREATE');
    assert.equal(detail.body.data.entries[0].signedAmount, 400000);
    assert.equal(detail.body.data.entries[0].actorUserId, userId);

    const listed = await api()
      .get(`/api/v1/operational-budgets/${fixture.budgetId}/commitments`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);

    assert.equal((await events(body.id, 'OPERATIONAL_COMMITMENT_CREATED')).length, 1);
  });

  it('rejects a commitment on a non-ACTIVE budget, wrong currency or foreign category', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();
    const other = await activeBudget();

    const wrongCurrency = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { currency: 'USD' }),
    );
    assert.equal(wrongCurrency.status, 400, JSON.stringify(wrongCurrency.body));
    assert.equal(
      wrongCurrency.body.error.code,
      'OPERATIONAL_COMMITMENT_CURRENCY_MISMATCH',
    );

    const foreignCategory = await commit(
      fixture.budgetId,
      commitmentPayload(other.categoryId),
    );
    assert.equal(foreignCategory.status, 400, JSON.stringify(foreignCategory.body));
    assert.equal(
      foreignCategory.body.error.code,
      'OPERATIONAL_COMMITMENT_CATEGORY_MISMATCH',
    );

    const draft = await activeBudget();
    const closed = await api()
      .post(`/api/v1/operational-budgets/${draft.budgetId}/close`)
      .set(auth())
      .send({});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const onClosed = await commit(
      draft.budgetId,
      commitmentPayload(draft.categoryId),
    );
    assert.equal(onClosed.status, 409, JSON.stringify(onClosed.body));
    assert.equal(onClosed.body.error.code, 'OPERATIONAL_BUDGET_NOT_ACTIVE');
  });

  it('rejects overspend on a STRICT budget and audits the rejection', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(500000);

    const first = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 400000 }),
    );
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const overspend = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 200000 }),
    );
    assert.equal(overspend.status, 409, JSON.stringify(overspend.body));
    assert.equal(
      overspend.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
    );
    const detailFields = Object.fromEntries(
      overspend.body.error.details.map(
        (entry: { field: string; message: string }) => [entry.field, entry.message],
      ),
    );
    assert.equal(detailFields.availableAmount, '100000.00');
    assert.equal(detailFields.requestedAmount, '200000.00');

    // Nothing was written by the rejected attempt.
    const rows = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [fixture.budgetId],
    );
    assert.equal(rows.rows[0].count, '1');

    // The rejection itself is audited even though its transaction rolled back.
    const rejections = await events(
      fixture.budgetId,
      'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
    );
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].metadata.requestedAmount, '200000.00');

    // An exactly-fitting commitment is still allowed.
    const exact = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 100000 }),
    );
    assert.equal(exact.status, 201, JSON.stringify(exact.body));
  });

  it('never overrides a STRICT budget, even with a reason', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(100000);
    const rejected = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, {
        amount: 200000,
        overspendOverrideReason: 'Emergency chiller failure.',
      }),
    );
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(
      rejected.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_OVERRIDE_NOT_ALLOWED',
    );
  });

  it('requires the separate override permission and an explicit reason on ALLOW_WITH_OVERRIDE', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(100000, 'ALLOW_WITH_OVERRIDE');

    // No reason → still rejected. Policy alone never permits overspend.
    const withoutReason = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 150000 }),
    );
    assert.equal(withoutReason.status, 409, JSON.stringify(withoutReason.body));
    assert.equal(
      withoutReason.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
    );

    // Reason but no override authority → 403. `operational_budget.manage`
    // alone must never imply the authority to exceed approved spending.
    const withoutPermission = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, {
        amount: 150000,
        overspendOverrideReason: 'Emergency chiller failure.',
      }),
    );
    assert.equal(withoutPermission.status, 403, JSON.stringify(withoutPermission.body));
    assert.equal(withoutPermission.body.error.code, 'PERMISSION_DENIED');

    const authorized = await createAdminUser();
    await buildingAssignmentService.createAssignment(authorized.userId, {
      buildingId: fixture.building.id,
    });
    await grantOverride(authorized.userId);

    const overridden = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, {
        amount: 150000,
        overspendOverrideReason: 'Emergency chiller failure.',
      }),
      authorized.token,
    );
    assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
    assert.equal(
      overridden.body.data.overspendOverride.reason,
      'Emergency chiller failure.',
    );
    assert.equal(
      overridden.body.data.overspendOverride.byUserId,
      authorized.userId,
    );

    const detail = await api()
      .get(`/api/v1/operational-commitments/${overridden.body.data.id}`)
      .set(auth());
    const entryTypes = detail.body.data.entries.map(
      (entry: { entryType: string }) => entry.entryType,
    );
    assert.deepEqual(entryTypes.sort(), ['CREATE', 'OVERRIDE']);

    const audited = await events(
      fixture.budgetId,
      'OPERATIONAL_BUDGET_OVERSPEND_OVERRIDDEN',
    );
    assert.equal(audited.length, 1);
    assert.equal(audited[0].metadata.overrideReason, 'Emergency chiller failure.');
  });

  it('is idempotent for creation and for every transition', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();
    const payload = commitmentPayload(fixture.categoryId, { amount: 300000 });

    const first = await commit(fixture.budgetId, payload);
    const replay = await commit(fixture.budgetId, payload);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, first.body.data.id);

    const rows = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [fixture.budgetId],
    );
    assert.equal(rows.rows[0].count, '1');

    const adjustKey = key();
    const adjust = {
      amount: 100000,
      reason: 'Scope increased.',
      idempotencyKey: adjustKey,
    };
    const adjusted = await api()
      .post(`/api/v1/operational-commitments/${first.body.data.id}/adjust`)
      .set(auth())
      .send(adjust);
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body.data.committedAmount, 400000);

    const adjustReplay = await api()
      .post(`/api/v1/operational-commitments/${first.body.data.id}/adjust`)
      .set(auth())
      .send(adjust);
    assert.equal(adjustReplay.status, 200, JSON.stringify(adjustReplay.body));
    assert.equal(adjustReplay.body.data.committedAmount, 400000);

    const entries = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM operational_commitment_entries
        WHERE commitment_id = $1 AND entry_type = 'ADJUST_INCREASE'`,
      [first.body.data.id],
    );
    assert.equal(entries.rows[0].count, '1');
  });

  it('adjusts, releases and cancels through append-only entries only', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();
    const created = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 400000 }),
    );
    const id = created.body.data.id;

    const decreased = await api()
      .post(`/api/v1/operational-commitments/${id}/adjust`)
      .set(auth())
      .send({ amount: -150000, reason: 'Scope reduced.', idempotencyKey: key() });
    assert.equal(decreased.status, 200, JSON.stringify(decreased.body));
    assert.equal(decreased.body.data.committedAmount, 250000);
    assert.equal(decreased.body.data.openAmount, 250000);
    assert.equal(decreased.body.data.status, 'COMMITTED');

    const released = await api()
      .post(`/api/v1/operational-commitments/${id}/release`)
      .set(auth())
      .send({ reason: 'Work no longer required.', idempotencyKey: key() });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.data.status, 'RELEASED');
    assert.equal(released.body.data.releasedAmount, 250000);
    assert.equal(released.body.data.openAmount, 0);
    assert.equal(typeof released.body.data.closedAt, 'string');

    // A closed commitment can no longer transition.
    const afterClose = await api()
      .post(`/api/v1/operational-commitments/${id}/adjust`)
      .set(auth())
      .send({ amount: 1000, reason: 'Too late.', idempotencyKey: key() });
    assert.equal(afterClose.status, 409, JSON.stringify(afterClose.body));
    assert.equal(afterClose.body.error.code, 'OPERATIONAL_COMMITMENT_NOT_OPEN');

    // The ledger reconstructs the header: SUM(signed_amount) = open_amount.
    const sum = await pool!.query<{ total: string; open: string }>(
      `SELECT COALESCE(SUM(e.signed_amount), 0)::text AS total,
              c.open_amount::text AS open
         FROM operational_commitments c
         LEFT JOIN operational_commitment_entries e ON e.commitment_id = c.id
        WHERE c.id = $1
        GROUP BY c.open_amount`,
      [id],
    );
    assert.equal(sum.rows[0].total, sum.rows[0].open);

    const cancellable = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 50000 }),
    );
    const cancelled = await api()
      .post(`/api/v1/operational-commitments/${cancellable.body.data.id}/cancel`)
      .set(auth())
      .send({ reason: 'Raised in error.', idempotencyKey: key() });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
  });

  it('actualizes without freeing budget and forbids cancellation afterwards', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(500000);
    const created = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 500000 }),
    );
    const id = created.body.data.id;

    const partial = await operationalCommitmentService.actualizeOperationalCommitment(
      id,
      { amount: 200000, idempotencyKey: key(), actorUserId: userId },
    );
    assert.equal(partial.status, 'PARTIALLY_ACTUALIZED');
    assert.equal(partial.actualizedAmount, 200000);
    assert.equal(partial.openAmount, 300000);
    assert.equal(partial.closedAt, null);

    // Actualization must NOT free budget: the whole plan is still consumed.
    const stillFull = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 1 }),
    );
    assert.equal(stillFull.status, 409, JSON.stringify(stillFull.body));
    assert.equal(
      stillFull.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
    );

    // A partially actualized commitment must be released, never cancelled.
    const cancel = await api()
      .post(`/api/v1/operational-commitments/${id}/cancel`)
      .set(auth())
      .send({ reason: 'Attempt.', idempotencyKey: key() });
    assert.equal(cancel.status, 409, JSON.stringify(cancel.body));
    assert.equal(
      cancel.body.error.code,
      'OPERATIONAL_COMMITMENT_CANCEL_AFTER_ACTUALIZATION',
    );

    // Decreasing below the actualized amount is impossible.
    const decrease = await api()
      .post(`/api/v1/operational-commitments/${id}/adjust`)
      .set(auth())
      .send({ amount: -400000, reason: 'Attempt.', idempotencyKey: key() });
    assert.equal(decrease.status, 409, JSON.stringify(decrease.body));
    assert.equal(
      decrease.body.error.code,
      'OPERATIONAL_COMMITMENT_DECREASE_BELOW_ACTUALIZED',
    );

    // Over-actualization beyond the open amount is impossible.
    await assert.rejects(
      operationalCommitmentService.actualizeOperationalCommitment(id, {
        amount: 400000,
        idempotencyKey: key(),
        actorUserId: userId,
      }),
      (error: { code?: string }) =>
        error.code === 'OPERATIONAL_COMMITMENT_ACTUALIZATION_EXCEEDS_OPEN',
    );

    const full = await operationalCommitmentService.actualizeOperationalCommitment(
      id,
      { amount: 300000, idempotencyKey: key(), actorUserId: userId },
    );
    assert.equal(full.status, 'ACTUALIZED');
    assert.equal(full.openAmount, 0);
    assert.equal(full.actualizedAmount, 500000);
    assert.equal(typeof full.closedAt, 'string');

    assert.equal(
      (await events(id, 'OPERATIONAL_COMMITMENT_ACTUALIZED')).length,
      2,
    );
  });

  it('frees budget only when a commitment is released or cancelled', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(300000);
    const created = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 300000 }),
    );

    const blocked = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 100000 }),
    );
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

    const released = await api()
      .post(`/api/v1/operational-commitments/${created.body.data.id}/release`)
      .set(auth())
      .send({ reason: 'Cancelled by the client.', idempotencyKey: key() });
    assert.equal(released.status, 200, JSON.stringify(released.body));

    const allowed = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 300000 }),
    );
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });

  it('serializes concurrent approvals so the same remainder is consumed once', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(100000);

    const [a, b] = await Promise.all([
      commit(fixture.budgetId, commitmentPayload(fixture.categoryId, { amount: 60000 })),
      commit(fixture.budgetId, commitmentPayload(fixture.categoryId, { amount: 60000 })),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(
      statuses,
      [201, 409],
      `expected exactly one approval, got ${JSON.stringify([a.body, b.body])}`,
    );
    const rejected = a.status === 409 ? a : b;
    assert.equal(
      rejected.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
    );

    const consumed = await pool!.query<{ total: string }>(
      `SELECT COALESCE(SUM(committed_amount - released_amount), 0)::text AS total
         FROM operational_commitments
        WHERE budget_id = $1 AND status <> 'CANCELLED'`,
      [fixture.budgetId],
    );
    assert.equal(consumed.rows[0].total, '60000.00');
  });

  it('enforces the ledger invariants at the database boundary', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();
    const created = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 100000 }),
    );
    const id = created.body.data.id;

    // Wrong sign for the entry type.
    await assert.rejects(
      pool!.query(
        `INSERT INTO operational_commitment_entries
           (id, commitment_id, entry_type, signed_amount, currency, idempotency_key, reason, actor_user_id)
         VALUES (gen_random_uuid(), $1, 'RELEASE', 100, 'IDR', $2, 'bad', $3)`,
        [id, key(), userId],
      ),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' &&
        error.constraint === 'operational_commitment_entries_sign_check',
    );

    // Unknown entry type.
    await assert.rejects(
      pool!.query(
        `INSERT INTO operational_commitment_entries
           (id, commitment_id, entry_type, signed_amount, currency, idempotency_key, actor_user_id)
         VALUES (gen_random_uuid(), $1, 'DELETE', -1, 'IDR', $2, $3)`,
        [id, key(), userId],
      ),
      (error: { code?: string }) => error.code === '23514',
    );

    // Duplicate idempotency key on the same commitment.
    const duplicate = key();
    await pool!.query(
      `INSERT INTO operational_commitment_entries
         (id, commitment_id, entry_type, signed_amount, currency, idempotency_key, reason, actor_user_id)
       VALUES (gen_random_uuid(), $1, 'OVERRIDE', 0, 'IDR', $2, 'marker', $3)`,
      [id, duplicate, userId],
    );
    await assert.rejects(
      pool!.query(
        `INSERT INTO operational_commitment_entries
           (id, commitment_id, entry_type, signed_amount, currency, idempotency_key, reason, actor_user_id)
         VALUES (gen_random_uuid(), $1, 'OVERRIDE', 0, 'IDR', $2, 'marker', $3)`,
        [id, duplicate, userId],
      ),
      (error: { code?: string }) => error.code === '23505',
    );

    // Amounts can never make the header inconsistent.
    await assert.rejects(
      pool!.query(
        `UPDATE operational_commitments
            SET actualized_amount = committed_amount + 1 WHERE id = $1`,
        [id],
      ),
      (error: { code?: string }) => error.code === '23514',
    );

    // The duplicate-actualization guard exists before any source is wired.
    const guard = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'operational_commitment_entries_actualization_unique'`,
    );
    assert.equal(guard.rowCount, 1);
    assert.match(guard.rows[0].indexdef, /source_binding_id/);
  });

  it('transitions the overspend policy of an ACTIVE budget only with the override authority', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget(100000);

    // The generic budget PATCH stays DRAFT-only.
    const patched = await api()
      .patch(`/api/v1/operational-budgets/${fixture.budgetId}`)
      .set(auth())
      .send({ overspendPolicy: 'ALLOW_WITH_OVERRIDE' });
    assert.equal(patched.status, 400, JSON.stringify(patched.body));
    assert.equal(patched.body.error.code, 'OPERATIONAL_BUDGET_NOT_DRAFT');

    // The narrow transition requires the override permission.
    const denied = await api()
      .post(`/api/v1/operational-budgets/${fixture.budgetId}/overspend-policy`)
      .set(auth())
      .send({
        overspendPolicy: 'ALLOW_WITH_OVERRIDE',
        reason: 'Emergency season.',
      });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const authorized = await createAdminUser();
    await buildingAssignmentService.createAssignment(authorized.userId, {
      buildingId: fixture.building.id,
    });
    await grantOverride(authorized.userId);

    const changed = await api()
      .post(`/api/v1/operational-budgets/${fixture.budgetId}/overspend-policy`)
      .set(auth(authorized.token))
      .send({
        overspendPolicy: 'ALLOW_WITH_OVERRIDE',
        reason: 'Emergency season.',
      });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.overspendPolicy, 'ALLOW_WITH_OVERRIDE');

    const audited = await events(
      fixture.budgetId,
      'OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED',
    );
    assert.equal(audited.length, 1);
    assert.equal(audited[0].metadata.budgetStatus, 'ACTIVE');
    assert.equal(audited[0].metadata.reason, 'Emergency season.');
  });

  it('preserves RBAC and Building isolation for the commitment surface', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();
    const created = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 100000 }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const plain = await createPlainSession();
    const noPermission = await api()
      .get(`/api/v1/operational-commitments/${created.body.data.id}`)
      .set(auth(plain));
    assert.equal(noPermission.status, 403);
    assert.equal(noPermission.body.error.code, 'PERMISSION_DENIED');

    const other = await createAdminUser();
    await structure(other.userId);
    const crossBuilding = await api()
      .get(`/api/v1/operational-commitments/${created.body.data.id}`)
      .set(auth(other.token));
    assert.equal(crossBuilding.status, 403);
    assert.equal(crossBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossWrite = await commit(
      fixture.budgetId,
      commitmentPayload(fixture.categoryId, { amount: 1000 }),
      other.token,
    );
    assert.equal(crossWrite.status, 403);
    assert.equal(crossWrite.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects malformed commitment input before touching the ledger', async (t) => {
    if (!ready(t)) return;
    const fixture = await activeBudget();

    for (const invalid of [
      { amount: 0 },
      { amount: -5 },
      { amount: 10.005 },
      { amount: 'many' },
      { reason: '' },
      { idempotencyKey: 'short' },
      { currency: 'THB' },
      { budgetCategoryId: 'not-a-uuid' },
      { status: 'COMMITTED' },
      { committedAmount: 10 },
      { origin: 'PO_LINE' },
      { purchaseOrderLineId: randomUUID() },
    ]) {
      const response = await commit(
        fixture.budgetId,
        commitmentPayload(fixture.categoryId, invalid),
      );
      assert.equal(
        response.status,
        400,
        `expected rejection for ${JSON.stringify(invalid)}: ${JSON.stringify(response.body)}`,
      );
    }

    const rows = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [fixture.budgetId],
    );
    assert.equal(rows.rows[0].count, '0');
  });
});

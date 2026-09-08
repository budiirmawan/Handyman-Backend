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
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-FX-01 PART 02 — FX Rate lifecycle + Client FX Policy, database-backed.
 *
 * Exercises what only a real database can prove: maker-checker against a
 * persisted row, the ACTIVE window conflict, exact supersession lineage in both
 * directions, `fx_rate_events` emission and immutability, Client FX policy
 * isolation and fail-closed semantics, the policy audit event, and RBAC denial.
 *
 * Skips when a local PostgreSQL test database is unavailable, following the
 * existing CUR-02 / FX-01 suite convention.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

/** Maker: may propose, must never be able to activate. */
let maker = { token: '', userId: '' };
/** Checker: a different authorized user. */
let checker = { token: '', userId: '' };

const FX_PERMISSIONS = [
  { code: 'fx_rate.read', name: 'Read FX Rates' },
  { code: 'fx_rate.manage', name: 'Manage FX Rates (Propose)' },
  { code: 'fx_rate.approve', name: 'Approve, Reject, Supersede or Deactivate FX Rates' },
  { code: 'client_fx_policy.read', name: 'Read Client FX Policy' },
  { code: 'client_fx_policy.manage', name: 'Manage Client FX Policy' },
] as const;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE fx_rate_events, fx_rates, client_fx_policies,
             operational_events, building_assignments,
             client_allowed_transaction_currencies, client_monetary_contexts,
             buildings, properties, users, roles, permissions, clients CASCADE`,
  );
  maker = await createAdminUser();
  checker = await createAdminUser();
  assert.notEqual(maker.userId, checker.userId, 'maker and checker must be distinct users');
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

/** A Client with an IDR base that the acting user can actually reach. */
async function reachableClient(actorUserId: string, base = 'IDR', allowed = ['IDR', 'USD', 'SGD']) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'FX Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(actorUserId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext(
    { clientId: client.id, baseCurrencyCode: base, defaultTransactionCurrencyCode: base, allowedCurrencyCodes: allowed },
    actorUserId,
  );
  return client;
}

function rateBody(overrides: Record<string, unknown> = {}) {
  return {
    baseCurrencyCode: 'USD',
    quoteCurrencyCode: 'IDR',
    rate: '16500',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    source: 'MANUAL_TREASURY',
    ...overrides,
  };
}

async function proposeRate(token: string, body: Record<string, unknown> = rateBody()): Promise<string> {
  const created = await api().post('/api/v1/fx-rates').set(auth(token)).send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

async function eventTypesFor(rateId: string): Promise<string[]> {
  const result = await pool!.query<{ event_type: string }>(
    'SELECT event_type FROM fx_rate_events WHERE fx_rate_id = $1 ORDER BY occurred_at, created_at, id',
    [rateId],
  );
  return result.rows.map((row) => row.event_type);
}

describe('CR-BE-FX-01 PART 02 — propose a rate', () => {
  it('creates a PENDING_APPROVAL rate and records FX_RATE_CREATED', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    const read = await api().get(`/api/v1/fx-rates/${id}`).set(auth(maker.token));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'PENDING_APPROVAL');
    assert.equal(read.body.data.rateType, 'REFERENCE');
    assert.equal(read.body.data.createdByUserId, maker.userId);
    assert.equal(read.body.data.approvedByUserId, null, 'an unapproved rate has no approver');
    assert.deepEqual(await eventTypesFor(id), ['FX_RATE_CREATED']);
  });

  it('rejects a rate whose currency leg is not ACTIVE in the master', async (t) => {
    if (!ready(t)) return;
    const created = await api().post('/api/v1/fx-rates').set(auth(maker.token))
      .send(rateBody({ quoteCurrencyCode: 'ZZZ' }));
    assert.equal(created.status, 400);
    assert.ok(
      created.body.error.code === 'VALIDATION_ERROR' || created.body.error.code === 'FX_RATE_CURRENCY_INACTIVE_OR_UNKNOWN',
      `unexpected code ${created.body.error.code}`,
    );
  });
});

describe('CR-BE-FX-01 PART 02 — maker-checker', () => {
  it('refuses to let the maker approve their own rate', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    const selfApprove = await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(maker.token));
    assert.equal(selfApprove.status, 409);
    assert.equal(selfApprove.body.error.code, 'FX_RATE_SELF_APPROVAL');

    const still = await api().get(`/api/v1/fx-rates/${id}`).set(auth(maker.token));
    assert.equal(still.body.data.status, 'PENDING_APPROVAL', 'a refused approval must change nothing');
    assert.deepEqual(await eventTypesFor(id), ['FX_RATE_CREATED'], 'no approval event may be written');
  });

  it('activates through a different authorized approver', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    const approved = await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'ACTIVE');
    assert.equal(approved.body.data.approvedByUserId, checker.userId);
    assert.equal(approved.body.data.createdByUserId, maker.userId);
    assert.deepEqual(await eventTypesFor(id), ['FX_RATE_CREATED', 'FX_RATE_APPROVED']);
  });
});

describe('CR-BE-FX-01 PART 02 — lifecycle transitions fail closed', () => {
  it('rejects approving an already ACTIVE rate', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));
    const again = await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'FX_RATE_INVALID_STATUS_TRANSITION');
  });

  it('rejects deactivating or superseding a rate that is not ACTIVE', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    const deactivate = await api().post(`/api/v1/fx-rates/${id}/deactivate`).set(auth(checker.token));
    assert.equal(deactivate.status, 409);
    assert.equal(deactivate.body.error.code, 'FX_RATE_INVALID_STATUS_TRANSITION');

    const supersede = await api().post(`/api/v1/fx-rates/${id}/supersede`).set(auth(checker.token))
      .send({ effectiveFrom: '2026-07-01T00:00:00.000Z' });
    assert.equal(supersede.status, 409);
    assert.equal(supersede.body.error.code, 'FX_RATE_INVALID_STATUS_TRANSITION');
  });

  it('rejects reviving a REJECTED rate (rejected -> active is impossible)', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    const rejected = await api().post(`/api/v1/fx-rates/${id}/reject`).set(auth(checker.token))
      .send({ reason: 'Wrong rate sheet' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.status, 'REJECTED');
    assert.equal(rejected.body.data.rejectedReason, 'Wrong rate sheet');
    assert.deepEqual(await eventTypesFor(id), ['FX_RATE_CREATED', 'FX_RATE_REJECTED']);

    const revive = await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));
    assert.equal(revive.status, 409);
    assert.equal(revive.body.error.code, 'FX_RATE_INVALID_STATUS_TRANSITION');

    const still = await api().get(`/api/v1/fx-rates/${id}`).set(auth(checker.token));
    assert.equal(still.body.data.status, 'REJECTED', 'REJECTED is terminal');
  });

  it('deactivates an ACTIVE rate and makes INACTIVE terminal', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token, rateBody({ baseCurrencyCode: 'SGD' }));
    await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));

    const deactivated = await api().post(`/api/v1/fx-rates/${id}/deactivate`).set(auth(checker.token))
      .send({ reason: 'Withdrawn' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.deactivatedByUserId, checker.userId);
    assert.deepEqual(await eventTypesFor(id), ['FX_RATE_CREATED', 'FX_RATE_APPROVED', 'FX_RATE_DEACTIVATED']);

    const revive = await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));
    assert.equal(revive.status, 409, 'INACTIVE -> ACTIVE must be impossible');
  });
});

describe('CR-BE-FX-01 PART 02 — ACTIVE window authority', () => {
  it('fails closed when activation would overlap an existing ACTIVE rate', async (t) => {
    if (!ready(t)) return;
    const incumbent = await proposeRate(maker.token, rateBody({
      effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-07-01T00:00:00.000Z',
    }));
    await api().post(`/api/v1/fx-rates/${incumbent}/approve`).set(auth(checker.token));

    const overlapping = await proposeRate(maker.token, rateBody({
      rate: '16600', effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: '2026-09-01T00:00:00.000Z',
    }));
    const conflict = await api().post(`/api/v1/fx-rates/${overlapping}/approve`).set(auth(checker.token));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'FX_RATE_ACTIVE_WINDOW_CONFLICT');

    // Nothing was silently shortened, superseded or window-rewritten.
    const unchanged = await api().get(`/api/v1/fx-rates/${incumbent}`).set(auth(checker.token));
    assert.equal(unchanged.body.data.status, 'ACTIVE');
    assert.equal(unchanged.body.data.effectiveTo, '2026-07-01T00:00:00.000Z');
    assert.equal(unchanged.body.data.rate, '16500');
    const stillPending = await api().get(`/api/v1/fx-rates/${overlapping}`).set(auth(checker.token));
    assert.equal(stillPending.body.data.status, 'PENDING_APPROVAL');
  });

  it('allows an adjacent window that starts exactly where the incumbent ends', async (t) => {
    if (!ready(t)) return;
    const incumbent = await proposeRate(maker.token, rateBody({
      baseCurrencyCode: 'EUR', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-07-01T00:00:00.000Z',
    }));
    await api().post(`/api/v1/fx-rates/${incumbent}/approve`).set(auth(checker.token));

    const adjacent = await proposeRate(maker.token, rateBody({
      baseCurrencyCode: 'EUR', rate: '17800', effectiveFrom: '2026-07-01T00:00:00.000Z',
    }));
    const approved = await api().post(`/api/v1/fx-rates/${adjacent}/approve`).set(auth(checker.token));
    assert.equal(approved.status, 200, '[from, to) means these windows do not overlap');
  });
});

describe('CR-BE-FX-01 PART 02 — supersession is the only correction path', () => {
  it('links successor and incumbent exactly, in one transaction', async (t) => {
    if (!ready(t)) return;
    const incumbentId = await proposeRate(maker.token, rateBody({
      baseCurrencyCode: 'MYR', effectiveFrom: '2026-01-01T00:00:00.000Z',
    }));
    await api().post(`/api/v1/fx-rates/${incumbentId}/approve`).set(auth(checker.token));

    const result = await api().post(`/api/v1/fx-rates/${incumbentId}/supersede`).set(auth(checker.token))
      .send({ rate: '3600.25', effectiveFrom: '2026-01-01T00:00:00.000Z' });
    assert.equal(result.status, 200, JSON.stringify(result.body));

    const { superseded, successor } = result.body.data;
    assert.equal(superseded.status, 'SUPERSEDED');
    assert.equal(successor.status, 'ACTIVE');
    assert.equal(successor.supersedesRateId, incumbentId, 'forward link must be exact');
    assert.equal(superseded.supersededByRateId, successor.id, 'reverse link must be exact');
    assert.equal(successor.rate, '3600.25');
    assert.equal(successor.baseCurrencyCode, 'MYR', 'the pair is inherited, never changed');
    assert.equal(successor.quoteCurrencyCode, 'IDR');
    assert.equal(successor.createdByUserId, maker.userId, 'authored by the incumbent maker');
    assert.equal(successor.approvedByUserId, checker.userId, 'approved by the superseding checker');

    // The incumbent's rate value was never rewritten.
    const row = await pool!.query<{ rate: string }>('SELECT rate FROM fx_rates WHERE id = $1', [incumbentId]);
    assert.equal(row.rows[0]!.rate, '16500', 'the superseded rate keeps its original value');

    assert.deepEqual(await eventTypesFor(incumbentId), ['FX_RATE_CREATED', 'FX_RATE_APPROVED', 'FX_RATE_SUPERSEDED']);
    assert.deepEqual(await eventTypesFor(successor.id), ['FX_RATE_CREATED']);
  });

  it('allows a window-only correction that reuses the exact stored rate', async (t) => {
    if (!ready(t)) return;
    const incumbentId = await proposeRate(maker.token, rateBody({
      baseCurrencyCode: 'AUD', rate: '10750.5', effectiveFrom: '2026-01-01T00:00:00.000Z',
    }));
    await api().post(`/api/v1/fx-rates/${incumbentId}/approve`).set(auth(checker.token));

    const result = await api().post(`/api/v1/fx-rates/${incumbentId}/supersede`).set(auth(checker.token))
      .send({ effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-12-31T00:00:00.000Z' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.successor.rate, '10750.5', 'the exact decimal is copied, not recomputed');
  });

  it('refuses supersession by the maker and rolls the incumbent back to ACTIVE', async (t) => {
    if (!ready(t)) return;
    const incumbentId = await proposeRate(maker.token, rateBody({
      baseCurrencyCode: 'JPY', effectiveFrom: '2026-01-01T00:00:00.000Z',
    }));
    await api().post(`/api/v1/fx-rates/${incumbentId}/approve`).set(auth(checker.token));

    const byMaker = await api().post(`/api/v1/fx-rates/${incumbentId}/supersede`).set(auth(maker.token))
      .send({ rate: '110', effectiveFrom: '2026-01-01T00:00:00.000Z' });
    assert.equal(byMaker.status, 409);
    assert.equal(byMaker.body.error.code, 'FX_RATE_SELF_APPROVAL');

    const still = await api().get(`/api/v1/fx-rates/${incumbentId}`).set(auth(checker.token));
    assert.equal(still.body.data.status, 'ACTIVE', 'a refused supersession must leave the incumbent ACTIVE');
    assert.equal(still.body.data.supersededByRateId, null);
  });

  it('never mutates the rate value directly', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token, rateBody({ baseCurrencyCode: 'GBP' }));
    await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(checker.token));
    const attempt = await sqlState('UPDATE fx_rates SET rate = 99999 WHERE id = $1', [id]);
    assert.equal(attempt, '23514', 'the rate column is immutable');
  });
});

describe('CR-BE-FX-01 PART 02 — fx_rate_events is the rate audit authority', () => {
  it('keeps the ledger append-only and Client-free', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token, rateBody({ baseCurrencyCode: 'CNY' }));
    const [event] = await eventTypesFor(id);
    assert.equal(event, 'FX_RATE_CREATED');

    const eventId = await pool!.query<{ id: string }>('SELECT id FROM fx_rate_events WHERE fx_rate_id = $1', [id]);
    assert.equal(await sqlState('UPDATE fx_rate_events SET metadata = $2 WHERE id = $1', [eventId.rows[0]!.id, '{}']), '23514');
    assert.equal(await sqlState('DELETE FROM fx_rate_events WHERE id = $1', [eventId.rows[0]!.id]), '23514');

    const columns = await pool!.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fx_rate_events'
    `);
    assert.ok(
      !columns.rows.some((row) => row.column_name === 'client_id'),
      'the platform-global rate ledger must not fabricate Client ownership',
    );
  });
});

async function sqlState(statement: string, params: unknown[] = []): Promise<string> {
  try {
    await pool!.query(statement, params);
    return 'NO_ERROR';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : 'UNKNOWN';
  }
}

describe('CR-BE-FX-01 PART 02 — Client FX policy', () => {
  it('reports absence honestly: no policy means FX is unavailable', async (t) => {
    if (!ready(t)) return;
    const client = await reachableClient(maker.userId);
    const read = await api().get(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.policy, null);
    assert.equal(read.body.data.fxAvailable, false, 'absence must never be treated as permission');
    assert.equal(read.body.data.baseCurrencyCode, 'IDR');
  });

  it('sets a policy whose reporting currency equals the base, and audits it', async (t) => {
    if (!ready(t)) return;
    const client = await reachableClient(maker.userId);
    const set = await api().put(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token)).send({
      fxEnabled: true, reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'],
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.data.fxEnabled, true);
    assert.equal(set.body.data.inversePermitted, false, 'inverse fails closed by default');
    assert.deepEqual(set.body.data.permittedSources, ['MANUAL_TREASURY']);

    const read = await api().get(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token));
    assert.equal(read.body.data.fxAvailable, true);

    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events WHERE client_id = $1 AND entity_type = 'CLIENT_FX_POLICY' ORDER BY occurred_at`,
      [client.id],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), ['CLIENT_FX_POLICY_SET']);

    const update = await api().put(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token)).send({
      fxEnabled: true, reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'], inversePermitted: true,
    });
    assert.equal(update.status, 200);
    const after = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events WHERE client_id = $1 AND entity_type = 'CLIENT_FX_POLICY' ORDER BY occurred_at`,
      [client.id],
    );
    assert.deepEqual(after.rows.map((row) => row.event_type), ['CLIENT_FX_POLICY_SET', 'CLIENT_FX_POLICY_CHANGED']);
  });

  it('never injects the base currency: a divergent reporting currency is rejected', async (t) => {
    if (!ready(t)) return;
    const client = await reachableClient(maker.userId);
    const set = await api().put(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token)).send({
      fxEnabled: true, reportingCurrencyCode: 'USD', permittedSources: ['MANUAL_TREASURY'],
    });
    assert.equal(set.status, 400);
    assert.equal(set.body.error.code, 'FX_POLICY_REPORTING_CURRENCY_NOT_BASE');
    const read = await api().get(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token));
    assert.equal(read.body.data.policy, null, 'nothing was written');
  });

  it('a disabled policy and an empty source set both make FX unavailable', async (t) => {
    if (!ready(t)) return;
    const disabledClient = await reachableClient(maker.userId);
    await api().put(`/api/v1/clients/${disabledClient.id}/fx-policy`).set(auth(maker.token)).send({
      fxEnabled: false, reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'],
    });
    const disabled = await api().get(`/api/v1/clients/${disabledClient.id}/fx-policy`).set(auth(maker.token));
    assert.equal(disabled.body.data.fxAvailable, false);

    const emptyClient = await reachableClient(maker.userId);
    await api().put(`/api/v1/clients/${emptyClient.id}/fx-policy`).set(auth(maker.token)).send({
      fxEnabled: true, reportingCurrencyCode: 'IDR', permittedSources: [],
    });
    const empty = await api().get(`/api/v1/clients/${emptyClient.id}/fx-policy`).set(auth(maker.token));
    assert.equal(empty.body.data.fxAvailable, false, 'an empty permitted-source set permits nothing');
    assert.equal(empty.body.data.policy.fxEnabled, true, 'the policy itself is still stored truthfully');
  });

  it('isolates one Client policy from another user', async (t) => {
    if (!ready(t)) return;
    // A Client the checker cannot reach at all.
    const client = await reachableClient(maker.userId);
    await api().put(`/api/v1/clients/${client.id}/fx-policy`).set(auth(maker.token)).send({
      fxEnabled: true, reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'],
    });
    const read = await api().get(`/api/v1/clients/${client.id}/fx-policy`).set(auth(checker.token));
    assert.equal(read.status, 403, 'an unreachable Client policy must not be readable');
    const write = await api().put(`/api/v1/clients/${client.id}/fx-policy`).set(auth(checker.token)).send({
      fxEnabled: true, reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'],
    });
    assert.equal(write.status, 403);
  });
});

describe('CR-BE-FX-01 PART 02 — RBAC', () => {
  it('denies proposing a rate to a read-only caller', async (t) => {
    if (!ready(t)) return;
    const token = await createSessionWithPermissions([FX_PERMISSIONS[0]!]);
    const read = await api().get('/api/v1/fx-rates').set(auth(token));
    assert.equal(read.status, 200);
    const create = await api().post('/api/v1/fx-rates').set(auth(token)).send(rateBody());
    assert.equal(create.status, 403);
  });

  it('denies approval to a maker-only caller — manage alone can never activate', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token);
    const token = await createSessionWithPermissions([FX_PERMISSIONS[0]!, FX_PERMISSIONS[1]!]);
    const approve = await api().post(`/api/v1/fx-rates/${id}/approve`).set(auth(token));
    assert.equal(approve.status, 403);
    const still = await api().get(`/api/v1/fx-rates/${id}`).set(auth(maker.token));
    assert.equal(still.body.data.status, 'PENDING_APPROVAL');
  });

  it('denies Client FX policy writes without client_fx_policy.manage', async (t) => {
    if (!ready(t)) return;
    const client = await reachableClient(maker.userId);
    const token = await createSessionWithPermissions([FX_PERMISSIONS[3]!]);
    const read = await api().get(`/api/v1/clients/${client.id}/fx-policy`).set(auth(token));
    assert.equal(read.status, 200);
    const write = await api().put(`/api/v1/clients/${client.id}/fx-policy`).set(auth(token)).send({
      fxEnabled: true, reportingCurrencyCode: 'IDR', permittedSources: ['MANUAL_TREASURY'],
    });
    assert.equal(write.status, 403);
  });
});

describe('CR-BE-FX-01 PART 02 — no conversion surface exists', () => {
  it('exposes no conversion, quote or ingestion endpoint', async (t) => {
    if (!ready(t)) return;
    const id = await proposeRate(maker.token, rateBody({ baseCurrencyCode: 'CHF' }));
    for (const path of [
      `/api/v1/fx-rates/${id}/convert`,
      '/api/v1/fx/convert',
      '/api/v1/fx/quote',
      '/api/v1/fx-rates/ingest',
      '/api/v1/fx/dashboard',
    ]) {
      const response = await api().post(path).set(auth(maker.token)).send({ amount: 100, from: 'USD', to: 'IDR' });
      assert.equal(response.status, 404, `${path} must not exist in PART 02`);
    }
  });
});

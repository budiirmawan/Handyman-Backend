import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  allowedCustomerTransitions,
  platformCustomerRepository,
  platformCustomerService,
  SAAS_CUSTOMER_STATUSES,
} from '../src/modules/platform-customers';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55472;
const DIR = '/tmp/asentra-saas01-dom-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

const AUTHORITY = 'platform.customer.manage';
let ACTOR = '';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 01 test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function createCustomer(overrides: Record<string, unknown> = {}) {
  return platformCustomerService.createSaaSCustomer(
    ACTOR,
    AUTHORITY,
    {
      code: `DOM_${suffix()}`,
      name: 'Domain Customer',
      ...overrides,
    },
    `dom-key-${suffix()}`,
  );
}

async function auditRows(customerId: string, eventType: string) {
  assert.ok(pool);
  const result = await pool.query<{
    event_type: string;
    client_id: string;
    actor_user_id: string | null;
    request_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type, client_id, actor_user_id, request_id, metadata
       FROM operational_events
      WHERE entity_type = 'SAAS_CUSTOMER' AND entity_id = $1 AND event_type = $2
      ORDER BY occurred_at ASC, id ASC`,
    [customerId, eventType],
  );
  return result.rows;
}

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
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
  const config = await ensureTestDatabase();
  if (!config) return;
  pool = await initDatabase(config as DatabaseConfig);
  await migrateUp(pool);
  // The platform actor must be a REAL user: both request_idempotency_records
  // and operational_events reference users(id).
  const { userService } = await import('../src/modules/users');
  const actor = await userService.createUser({
    email: `saas-actor-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'SaaS Control-Plane Actor',
  });
  ACTOR = actor.id;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
});

describe('CR-BE-SAAS-01 PART 01 — SaaS Customer domain: lifecycle table', () => {
  it('encodes exactly the frozen transitions', () => {
    assert.deepEqual(
      [...allowedCustomerTransitions('PROSPECT')].sort(),
      ['TERMINATED', 'TRIAL'],
    );
    assert.deepEqual(
      [...allowedCustomerTransitions('TRIAL')].sort(),
      ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
    );
    assert.deepEqual(
      [...allowedCustomerTransitions('ACTIVE')].sort(),
      ['GRACE', 'SUSPENDED', 'TERMINATED'],
    );
    assert.deepEqual(
      [...allowedCustomerTransitions('GRACE')].sort(),
      ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
    );
    assert.deepEqual(
      [...allowedCustomerTransitions('SUSPENDED')].sort(),
      ['ACTIVE', 'TERMINATED'],
    );
    assert.deepEqual(allowedCustomerTransitions('TERMINATED'), []);
    // Legacy INACTIVE is terminal-equivalent.
    assert.deepEqual(allowedCustomerTransitions('INACTIVE'), []);
  });

  it('exposes exactly the frozen lifecycle states (no invented states)', () => {
    assert.deepEqual([...SAAS_CUSTOMER_STATUSES].sort(), [
      'ACTIVE',
      'GRACE',
      'PROSPECT',
      'SUSPENDED',
      'TERMINATED',
      'TRIAL',
    ]);
  });
});

describe('CR-BE-SAAS-01 PART 01 — SaaS Customer domain: create', () => {
  it('creates in PROSPECT and audits SAAS_CUSTOMER_CREATED', async (t) => {
    if (!ready(t) || !pool) return;
    const { data } = await createCustomer({
      displayName: 'Display Name',
      billingEmail: 'Billing@Example.com',
      country: 'id',
      currencyCode: 'IDR',
      timezone: 'Asia/Jakarta',
    });

    assert.equal(data.status, 'PROSPECT');
    assert.equal(data.version, 1);
    // Normalization rules.
    assert.equal(data.code, data.code.toUpperCase());
    assert.equal(data.billingEmail, 'billing@example.com');
    assert.equal(data.country, 'ID');

    const rows = await auditRows(data.id, 'SAAS_CUSTOMER_CREATED');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_id, data.id);
    assert.equal(rows[0].actor_user_id, ACTOR);
    assert.equal(rows[0].metadata.authority, AUTHORITY);
    assert.equal((rows[0].metadata.after as { code: string }).code, data.code);
  });

  it('replays the same idempotency key + body without duplicating', async (t) => {
    if (!ready(t) || !pool) return;
    const body = {
      code: `IDEM_${suffix()}`,
      name: 'Idempotent Customer',
      billingEmail: `idem-${suffix().toLowerCase()}@example.com`,
    };
    const key = `idem-${suffix()}`;

    const first = await platformCustomerService.createSaaSCustomer(
      ACTOR,
      AUTHORITY,
      body,
      key,
    );
    const replay = await platformCustomerService.createSaaSCustomer(
      ACTOR,
      AUTHORITY,
      body,
      key,
    );

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.id, first.data.id);

    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM clients WHERE id = $1`,
      [first.data.id],
    );
    assert.equal(count.rows[0].n, 1);
  });

  it('conflicts on the same key with a different semantic body', async (t) => {
    if (!ready(t)) return;
    const key = `idem-${suffix()}`;
    const body = { code: `IDC_${suffix()}`, name: 'Conflict Customer' };
    await platformCustomerService.createSaaSCustomer(ACTOR, AUTHORITY, body, key);

    await assert.rejects(
      platformCustomerService.createSaaSCustomer(
        ACTOR,
        AUTHORITY,
        { ...body, name: 'Different Name' },
        key,
      ),
      (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects duplicate code and duplicate billing email', async (t) => {
    if (!ready(t)) return;
    const code = `DUP_${suffix()}`;
    await createCustomer({ code });
    await assert.rejects(
      createCustomer({ code }),
      (error: { code?: string }) =>
        error.code === 'SAAS_CUSTOMER_CODE_ALREADY_EXISTS',
    );

    const email = `dup-${suffix().toLowerCase()}@example.com`;
    await createCustomer({ billingEmail: email });
    await assert.rejects(
      createCustomer({ billingEmail: email }),
      (error: { code?: string }) =>
        error.code === 'SAAS_CUSTOMER_BILLING_EMAIL_ALREADY_EXISTS',
    );
  });

  it('rejects unknown or inactive currency references', async (t) => {
    if (!ready(t) || !pool) return;
    await assert.rejects(
      createCustomer({ currencyCode: 'ZZZ' }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
    // Deactivate an ACTIVE currency, then retry.
    await pool.query(
      `UPDATE currencies SET status = 'INACTIVE' WHERE code = 'CNY'`,
    );
    try {
      await assert.rejects(
        createCustomer({ currencyCode: 'CNY' }),
        (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
      );
    } finally {
      await pool.query(
        `UPDATE currencies SET status = 'ACTIVE' WHERE code = 'CNY'`,
      );
    }
  });
});

describe('CR-BE-SAAS-01 PART 01 — SaaS Customer domain: update', () => {
  it('updates registry fields under version check and audits before/after', async (t) => {
    if (!ready(t)) return;
    const { data } = await createCustomer({ name: 'Before Name' });

    const updated = await platformCustomerService.updateSaaSCustomer(
      ACTOR,
      AUTHORITY,
      data.id,
      { expectedVersion: data.version, name: 'After Name', address: 'Jl. X' },
    );

    assert.equal(updated.name, 'After Name');
    assert.equal(updated.address, 'Jl. X');
    assert.equal(updated.version, data.version + 1);

    const rows = await auditRows(data.id, 'SAAS_CUSTOMER_UPDATED');
    assert.equal(rows.length, 1);
    const metadata = rows[0].metadata;
    assert.deepEqual(metadata.changedFields, ['name', 'address']);
    assert.equal((metadata.before as { name: string }).name, 'Before Name');
    assert.equal((metadata.after as { name: string }).name, 'After Name');
  });

  it('rejects a stale expectedVersion with VERSION_CONFLICT (no last-write-wins)', async (t) => {
    if (!ready(t)) return;
    const { data } = await createCustomer();

    // First update wins.
    await platformCustomerService.updateSaaSCustomer(
      ACTOR,
      AUTHORITY,
      data.id,
      { expectedVersion: data.version, description: 'winner' },
    );

    // Second update with the STALE version fails cleanly.
    await assert.rejects(
      platformCustomerService.updateSaaSCustomer(
        ACTOR,
        AUTHORITY,
        data.id,
        { expectedVersion: data.version, description: 'loser' },
      ),
      (error: { code?: string; conflict?: { version: number; expectedVersion: number } }) => {
        assert.equal(error.code, 'VERSION_CONFLICT');
        assert.equal(error.conflict?.version, data.version + 1);
        assert.equal(error.conflict?.expectedVersion, data.version);
        return true;
      },
    );
  });

  it('returns 404 for an unknown customer id (identity not interchangeable)', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      platformCustomerService.updateSaaSCustomer(ACTOR, AUTHORITY, randomUUID(), {
        expectedVersion: 1,
        name: 'Ghost',
      }),
      (error: { code?: string }) => error.code === 'SAAS_CUSTOMER_NOT_FOUND',
    );
  });
});

describe('CR-BE-SAAS-01 PART 01 — SaaS Customer domain: lifecycle transitions', () => {
  it('walks the full frozen chain with per-transition audit', async (t) => {
    if (!ready(t)) return;
    const { data } = await createCustomer();

    const chain: Array<{ to: string; reason: string }> = [
      { to: 'TRIAL', reason: 'trial started' },
      { to: 'ACTIVE', reason: 'trial converted' },
      { to: 'GRACE', reason: 'past due grace' },
      { to: 'SUSPENDED', reason: 'grace elapsed' },
      { to: 'ACTIVE', reason: 'payment resolved + approved reactivation' },
      { to: 'TERMINATED', reason: 'customer terminated' },
    ];

    let version = data.version;
    for (const step of chain) {
      const result = await platformCustomerService.transitionSaaSCustomerStatus(
        ACTOR,
        AUTHORITY,
        data.id,
        { toStatus: step.to as never, reason: step.reason, expectedVersion: version },
      );
      version = result.version;
    }

    const rows = await auditRows(data.id, 'SAAS_CUSTOMER_STATUS_CHANGED');
    assert.equal(rows.length, chain.length);
    assert.deepEqual(
      rows.map((row) => (row.metadata.before as { status: string }).status),
      ['PROSPECT', 'TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED', 'ACTIVE'],
    );
    assert.deepEqual(
      rows.map((row) => (row.metadata.after as { status: string }).status),
      chain.map((step) => step.to),
    );
    assert.equal(rows[0].metadata.reason, 'trial started');
    assert.equal(rows[0].actor_user_id, ACTOR);
    assert.equal(rows[0].metadata.authority, AUTHORITY);
  });

  it('rejects non-frozen transitions', async (t) => {
    if (!ready(t)) return;
    const { data } = await createCustomer();

    const denied: Array<{ to: string; expectedFrom: string }> = [
      { to: 'ACTIVE', expectedFrom: 'PROSPECT' }, // skips TRIAL
      { to: 'GRACE', expectedFrom: 'PROSPECT' },
    ];
    for (const step of denied) {
      await assert.rejects(
        platformCustomerService.transitionSaaSCustomerStatus(
          ACTOR,
          AUTHORITY,
          data.id,
          { toStatus: step.to as never, reason: 'nope', expectedVersion: data.version },
        ),
        (error: { code?: string; message: string }) => {
          assert.equal(error.code, 'SAAS_CUSTOMER_STATUS_NOT_ALLOWED');
          assert.match(error.message, new RegExp(step.expectedFrom));
          return true;
        },
      );
    }

    // Trial -> GRACE is not frozen (GRACE follows ACTIVE billing failure).
    await platformCustomerService.transitionSaaSCustomerStatus(
      ACTOR,
      AUTHORITY,
      data.id,
      { toStatus: 'TRIAL', reason: 'trial started', expectedVersion: data.version },
    );
    await assert.rejects(
      platformCustomerService.transitionSaaSCustomerStatus(
        ACTOR,
        AUTHORITY,
        data.id,
        { toStatus: 'GRACE', reason: 'nope', expectedVersion: data.version + 1 },
      ),
      (error: { code?: string }) => error.code === 'SAAS_CUSTOMER_STATUS_NOT_ALLOWED',
    );
  });

  it('TERMINATED is terminal; INACTIVE (legacy) has no outgoing transitions', async (t) => {
    if (!ready(t) || !pool) return;
    const { data } = await createCustomer();
    await platformCustomerService.transitionSaaSCustomerStatus(
      ACTOR,
      AUTHORITY,
      data.id,
      { toStatus: 'TERMINATED', reason: 'end', expectedVersion: data.version },
    );
    await assert.rejects(
      platformCustomerService.transitionSaaSCustomerStatus(
        ACTOR,
        AUTHORITY,
        data.id,
        { toStatus: 'ACTIVE', reason: 'revive', expectedVersion: data.version + 1 },
      ),
      (error: { code?: string }) => error.code === 'SAAS_CUSTOMER_STATUS_NOT_ALLOWED',
    );

    const legacyId = randomUUID();
    const legacyCode = `LEG_${suffix()}`;
    await pool.query(
      `INSERT INTO clients (id, code, name, status)
       VALUES ($1, $2, 'Legacy Inactive', 'INACTIVE')`,
      [legacyId, legacyCode],
    );
    await assert.rejects(
      platformCustomerService.transitionSaaSCustomerStatus(
        ACTOR,
        AUTHORITY,
        legacyId,
        { toStatus: 'TRIAL', reason: 'revive legacy', expectedVersion: 1 },
      ),
      (error: { code?: string }) => error.code === 'SAAS_CUSTOMER_STATUS_NOT_ALLOWED',
    );
  });

  it('honours the version check on transitions', async (t) => {
    if (!ready(t)) return;
    const { data } = await createCustomer();
    await assert.rejects(
      platformCustomerService.transitionSaaSCustomerStatus(
        ACTOR,
        AUTHORITY,
        data.id,
        { toStatus: 'TRIAL', reason: 'stale', expectedVersion: 999 },
      ),
      (error: { code?: string }) => error.code === 'VERSION_CONFLICT',
    );
  });
});

describe('CR-BE-SAAS-01 PART 01 — SaaS Customer domain: list/read', () => {
  it('filters by status and q and pages deterministically', async (t) => {
    if (!ready(t) || !pool) return;
    const marker = suffix().slice(0, 6);
    const c1 = await createCustomer({ code: `F${marker}A`, name: `Filter ${marker} Alpha` });
    await createCustomer({ code: `F${marker}B`, name: `Filter ${marker} Beta` });

    const list = await platformCustomerService.listSaaSCustomers({
      filters: { q: marker },
      page: 1,
      pageSize: 10,
    });
    assert.ok(list.total >= 2);
    const codes = list.customers.map((customer) => customer.code);
    assert.ok(codes.includes(`F${marker}A`));
    assert.ok(codes.includes(`F${marker}B`));

    const prospects = await platformCustomerService.listSaaSCustomers({
      filters: { status: 'PROSPECT', q: marker },
      page: 1,
      pageSize: 10,
    });
    assert.ok(
      prospects.customers.every((customer) => customer.status === 'PROSPECT'),
    );
    assert.equal(prospects.customers.length, 2);
    const prospectIds = new Set(prospects.customers.map((c) => c.id));
    assert.ok(prospectIds.has(c1.data.id));

    const paged = await platformCustomerService.listSaaSCustomers({
      filters: { q: marker },
      page: 1,
      pageSize: 1,
    });
    assert.equal(paged.customers.length, 1);
    assert.equal(paged.total, 2);
    assert.equal(paged.totalPages, 2);
  });

  it('detail read embeds existing subscription summaries', async (t) => {
    if (!ready(t) || !pool) return;
    const { data } = await createCustomer();

    // Activate the customer through the frozen lifecycle so a legacy
    // business-plane subscription may exist (subscription creation requires
    // an ACTIVE client).
    let version = data.version;
    for (const toStatus of ['TRIAL', 'ACTIVE'] as const) {
      const result = await platformCustomerService.transitionSaaSCustomerStatus(
        ACTOR,
        AUTHORITY,
        data.id,
        { toStatus, reason: 'test activation', expectedVersion: version },
      );
      version = result.version;
    }

    // A legacy business-plane subscription for the same customer row.
    const { subscriptionService } = await import('../src/modules/subscriptions');
    await subscriptionService.createSubscription({
      clientId: data.id,
      code: `SUB_${suffix()}`,
      planCode: 'BASIC',
      startsAt: new Date(),
    });

    const detail = await platformCustomerService.getSaaSCustomerDetail(data.id);
    assert.equal(detail.subscriptions.length, 1);
    assert.equal(detail.subscriptions[0].code.startsWith('SUB_'), true);
    assert.equal(detail.subscriptions[0].status, 'ACTIVE');
    assert.ok(detail.subscriptions[0].startsAt);
    assert.equal(detail.subscriptions[0].endsAt, null);
  });

  it('repository read returns the version token for optimistic concurrency', async (t) => {
    if (!ready(t)) return;
    const { data } = await createCustomer();
    const record = await platformCustomerRepository.findById(data.id);
    assert.ok(record);
    assert.equal(record.version, 1);
  });
});

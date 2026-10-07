import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';

import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
// Imported from the repository module rather than the `fx-rates` barrel: the
// barrel also re-exports the PART 02 router, which drags in Express and the auth
// chain. Tests should depend on the narrowest module that provides what they use.
import {
  clientFxPolicyRepository,
  fxRateEventRepository,
  fxRateRepository,
} from '../src/modules/fx-rates/fx-rate.repository';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-FX-01 PART 01 — FX Rate Authority database invariants.
 *
 * Covers exactly what `0333_create_fx_rate_authority_and_client_fx_policy`
 * guarantees and what the domain layer alone cannot: the Currency Master
 * foreign keys, the GiST ACTIVE-window exclusion, the business-field
 * immutability and lifecycle triggers, the append-only audit ledger, the
 * Client FX policy trigger, and migration down/up reversibility.
 *
 * Skips when a local PostgreSQL test database is unavailable, following the
 * existing CUR-02 suite convention.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let userId = '';
let checkerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE fx_rate_events, fx_rates, client_fx_policies,
             client_allowed_transaction_currencies, client_monetary_contexts,
             users, roles, permissions, clients CASCADE`,
  );
  const maker = await createAdminUser();
  userId = maker.userId;
  // A distinct checker: the maker-checker CHECK makes self-approval impossible.
  const checker = await createAdminUser();
  checkerUserId = checker.userId;
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

async function activeRate(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate_type, rate,
       effective_from, effective_to, status, source, created_by_user_id,
       approved_by_user_id, approved_at)
     VALUES ($1,$2,$3,'REFERENCE',$4,$5,$6,'ACTIVE','MANUAL_TREASURY',$7,$8,NOW())`,
    [
      id,
      overrides.base_currency_code ?? 'USD',
      overrides.quote_currency_code ?? 'IDR',
      overrides.rate ?? '16500',
      overrides.effective_from ?? '2026-01-01T00:00:00.000Z',
      overrides.effective_to ?? null,
      overrides.created_by_user_id ?? userId,
      overrides.approved_by_user_id ?? checkerUserId,
    ],
  );
  return id;
}

async function clientWithMonetaryContext(
  base = 'IDR',
  allowed: string[] = ['IDR', 'USD'],
): Promise<string> {
  const client = await clientService.createClient({
    code: `C_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'FX Client',
  });
  await clientMonetaryContextService.setClientMonetaryContext(
    { clientId: client.id, baseCurrencyCode: base, defaultTransactionCurrencyCode: base, allowedCurrencyCodes: allowed },
    userId,
  );
  return client.id;
}

describe('CR-BE-FX-01 PART 01 — fx_rates authority invariants', () => {
  it('persists a proposed rate with NUMERIC(24,12) fidelity', async (t) => {
    if (!ready(t)) return;
    const rate = await fxRateRepository.insert({
      id: randomUUID(),
      baseCurrencyCode: 'USD',
      quoteCurrencyCode: 'IDR',
      rate: '16500.123456789012',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      source: 'MANUAL_TREASURY',
      createdByUserId: userId,
    });
    assert.equal(rate.status, 'PENDING_APPROVAL');
    assert.equal(rate.rateType, 'REFERENCE');
    assert.equal(Number(rate.rate), 16500.123456789012);
    assert.equal(rate.approvedByUserId, null);
  });

  it('rejects base equal to quote at the database level', async (t) => {
    if (!ready(t)) return;
    assert.equal(await sqlState(`
      INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, source, created_by_user_id)
      VALUES ($1,'USD','USD',1,'2026-01-01','MANUAL_TREASURY',$2)`, [randomUUID(), userId]), '23514');
  });

  it('rejects a zero or negative rate at the database level', async (t) => {
    if (!ready(t)) return;
    for (const rate of ['0', '-16500']) {
      assert.equal(
        await sqlState(`
          INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, source, created_by_user_id)
          VALUES ($1,'USD','IDR',$2,'2026-01-01','MANUAL_TREASURY',$3)`, [randomUUID(), rate, userId]),
        '23514',
        `rate ${rate} must be rejected`,
      );
    }
  });

  it('enforces the Currency Master foreign key on both legs', async (t) => {
    if (!ready(t)) return;
    assert.equal(
      await sqlState(`
        INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, source, created_by_user_id)
        VALUES ($1,'ZZZ','IDR',1,'2026-01-01','MANUAL_TREASURY',$2)`, [randomUUID(), userId]),
      '23503',
      'an unknown currency code must violate the currencies FK',
    );
  });

  it('accepts only rate_type REFERENCE', async (t) => {
    if (!ready(t)) return;
    for (const rateType of ['SPOT', 'DAILY', 'MONTH_END', 'ACCOUNTING', 'CONTRACTUAL']) {
      const state = await sqlState(
        `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate_type, rate, effective_from, source, created_by_user_id)
         VALUES ($1,'USD','IDR',$2,1,'2026-01-01','MANUAL_TREASURY',$3)`,
        [randomUUID(), rateType, userId],
      );
      assert.equal(state, '23514', `${rateType} must not be accepted`);
    }
  });

  it('accepts only source MANUAL_TREASURY (no provider ingestion exists)', async (t) => {
    if (!ready(t)) return;
    for (const source of ['BANK_INDONESIA', 'ERP', 'EXTERNAL_API']) {
      assert.equal(
        await sqlState(
          `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, source, created_by_user_id)
           VALUES ($1,'USD','IDR',1,'2026-01-01',$2,$3)`,
          [randomUUID(), source, userId],
        ),
        '23514',
        `${source} must not be accepted`,
      );
    }
  });

  it('accepts only the governed lifecycle statuses', async (t) => {
    if (!ready(t)) return;
    for (const status of ['APPROVED', 'LIVE', 'PUBLISHED', 'DRAFT']) {
      assert.equal(
        await sqlState(
          `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, status, source, created_by_user_id)
           VALUES ($1,'USD','IDR',1,'2026-01-01',$2,'MANUAL_TREASURY',$3)`,
          [randomUUID(), status, userId],
        ),
        '23514',
        `${status} must not be accepted`,
      );
    }
  });

  it('rejects an effective window that is not closed-open', async (t) => {
    if (!ready(t)) return;
    const equal = await sqlState(
      `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, effective_to, source, created_by_user_id)
       VALUES ($1,'USD','IDR',1,'2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z','MANUAL_TREASURY',$2)`,
      [randomUUID(), userId],
    );
    assert.equal(equal, '23514', 'equal bounds make [from, to) empty and must be rejected');
    const inverted = await sqlState(
      `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, effective_to, source, created_by_user_id)
       VALUES ($1,'USD','IDR',1,'2026-06-01T00:00:00.000Z','2026-05-01T00:00:00.000Z','MANUAL_TREASURY',$2)`,
      [randomUUID(), userId],
    );
    assert.equal(inverted, '23514', 'effective_to must be strictly later than effective_from');
  });

  it('rejects overlapping ACTIVE windows for the same governed rate identity', async (t) => {
    if (!ready(t)) return;
    await activeRate({ effective_from: '2026-01-01T00:00:00.000Z', effective_to: '2026-07-01T00:00:00.000Z' });
    assert.equal(
      await sqlState(
        `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, effective_to,
           status, source, created_by_user_id, approved_by_user_id, approved_at)
         VALUES ($1,'USD','IDR',16600,'2026-03-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',
           'ACTIVE','MANUAL_TREASURY',$2,$3,NOW())`,
        [randomUUID(), userId, checkerUserId],
      ),
      '23P01',
      'the GiST exclusion must make an ambiguous ACTIVE rate impossible',
    );
  });

  it('allows adjacent, non-overlapping ACTIVE windows', async (t) => {
    if (!ready(t)) return;
    await activeRate({
      base_currency_code: 'SGD', quote_currency_code: 'IDR',
      effective_from: '2026-01-01T00:00:00.000Z', effective_to: '2026-07-01T00:00:00.000Z',
    });
    const adjacent = await sqlState(
      `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from, effective_to,
         status, source, created_by_user_id, approved_by_user_id, approved_at)
       VALUES ($1,'SGD','IDR',12000,'2026-07-01T00:00:00.000Z',NULL,
         'ACTIVE','MANUAL_TREASURY',$2,$3,NOW())`,
      [randomUUID(), userId, checkerUserId],
    );
    assert.equal(adjacent, 'NO_ERROR', 'a window starting exactly where the previous ends must be accepted');
  });

  it('allows the same window for a different pair and for non-ACTIVE rows', async (t) => {
    if (!ready(t)) return;
    await activeRate({
      base_currency_code: 'EUR', quote_currency_code: 'IDR',
      effective_from: '2026-01-01T00:00:00.000Z',
    });
    // Different quote currency -> different governed identity.
    const otherPair = await sqlState(
      `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from,
         status, source, created_by_user_id, approved_by_user_id, approved_at)
       VALUES ($1,'EUR','USD',1.08,'2026-01-01T00:00:00.000Z','ACTIVE','MANUAL_TREASURY',$2,$3,NOW())`,
      [randomUUID(), userId, checkerUserId],
    );
    assert.equal(otherPair, 'NO_ERROR');
    // PENDING_APPROVAL rows are outside the exclusion predicate.
    const pending = await sqlState(
      `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from,
         status, source, created_by_user_id)
       VALUES ($1,'EUR','IDR',17000,'2026-01-01T00:00:00.000Z','PENDING_APPROVAL','MANUAL_TREASURY',$2)`,
      [randomUUID(), userId],
    );
    assert.equal(pending, 'NO_ERROR', 'only ACTIVE rates are constrained against overlap');
  });
});

describe('CR-BE-FX-01 PART 01 — immutability and lifecycle guards', () => {
  it('refuses to rewrite a stored rate; correction must use supersession', async (t) => {
    if (!ready(t)) return;
    const id = await activeRate({ base_currency_code: 'JPY', quote_currency_code: 'IDR' });
    assert.equal(
      await sqlState('UPDATE fx_rates SET rate = 999 WHERE id = $1', [id]),
      '23514',
      'the rate value must be immutable',
    );
    assert.equal(
      await sqlState('UPDATE fx_rates SET base_currency_code = $2 WHERE id = $1', [id, 'USD']),
      '23514',
      'the base currency leg must be immutable',
    );
    assert.equal(
      await sqlState('UPDATE fx_rates SET effective_from = $2 WHERE id = $1', [id, '2025-01-01T00:00:00.000Z']),
      '23514',
      'the effective window must be immutable',
    );
  });

  it('permits a governed status transition but rejects an ungoverned one', async (t) => {
    if (!ready(t)) return;
    const id = await activeRate({ base_currency_code: 'MYR', quote_currency_code: 'IDR' });
    assert.equal(
      await sqlState(
        'UPDATE fx_rates SET status = $2, deactivated_by_user_id = $3, deactivated_at = NOW(), updated_at = NOW() WHERE id = $1',
        [id, 'INACTIVE', checkerUserId],
      ),
      'NO_ERROR',
      'ACTIVE -> INACTIVE is a governed transition',
    );
    assert.equal(
      await sqlState('UPDATE fx_rates SET status = $2, updated_at = NOW() WHERE id = $1', [id, 'ACTIVE']),
      '23514',
      'INACTIVE is terminal and must never be resurrected',
    );
  });

  it('requires an approver who is not the maker', async (t) => {
    if (!ready(t)) return;
    assert.equal(
      await sqlState(
        `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from,
           status, source, created_by_user_id, approved_by_user_id, approved_at)
         VALUES ($1,'AUD','IDR',10500,'2026-01-01T00:00:00.000Z','ACTIVE','MANUAL_TREASURY',$2,$2,NOW())`,
        [randomUUID(), userId],
      ),
      '23514',
      'self-approval must be structurally impossible',
    );
  });

  it('requires approval metadata before a rate can be ACTIVE', async (t) => {
    if (!ready(t)) return;
    assert.equal(
      await sqlState(
        `INSERT INTO fx_rates (id, base_currency_code, quote_currency_code, rate, effective_from,
           status, source, created_by_user_id)
         VALUES ($1,'GBP','IDR',21000,'2026-01-01T00:00:00.000Z','ACTIVE','MANUAL_TREASURY',$2)`,
        [randomUUID(), userId],
      ),
      '23514',
      'a provider or maker may propose but never activate',
    );
  });
});

describe('CR-BE-FX-01 PART 01 — fx_rate_events is append-only', () => {
  it('records an event and refuses to update or delete it', async (t) => {
    if (!ready(t)) return;
    const id = await activeRate({ base_currency_code: 'CNY', quote_currency_code: 'IDR' });
    const event = await fxRateEventRepository.append({
      fxRateId: id,
      eventType: 'FX_RATE_APPROVED',
      actorUserId: checkerUserId,
      metadata: { rate: '16500' },
    });
    assert.equal(event.fxRateId, id);
    assert.equal((await fxRateEventRepository.listForRate(id)).length, 1);
    assert.equal(
      await sqlState('UPDATE fx_rate_events SET metadata = $2 WHERE id = $1', [event.id, '{}']),
      '23514',
      'an audit row that can be edited is not an audit',
    );
    assert.equal(
      await sqlState('DELETE FROM fx_rate_events WHERE id = $1', [event.id]),
      '23514',
      'an audit row that can be deleted is not an audit',
    );
  });

  it('accepts only the governed event vocabulary', async (t) => {
    if (!ready(t)) return;
    const id = await activeRate({ base_currency_code: 'CHF', quote_currency_code: 'IDR' });
    assert.equal(
      await sqlState(
        'INSERT INTO fx_rate_events (id, fx_rate_id, event_type) VALUES ($1,$2,$3)',
        [randomUUID(), id, 'FX_RATE_CONVERTED'],
      ),
      '23514',
      'FX-01 rate audit has exactly five event types',
    );
  });
});

describe('CR-BE-FX-01 PART 01 — Client FX policy is isolated and fail-closed', () => {
  it('defaults fx_enabled and inverse_permitted to false at the database level', async (t) => {
    if (!ready(t)) return;
    const clientId = await clientWithMonetaryContext();
    await pool!.query(
      `INSERT INTO client_fx_policies (client_id, reporting_currency_code, permitted_sources,
         created_by_user_id, updated_by_user_id)
       VALUES ($1,'IDR',ARRAY['MANUAL_TREASURY'],$2,$2)`,
      [clientId, userId],
    );
    const policy = await clientFxPolicyRepository.findByClientId(clientId);
    assert.ok(policy, 'policy row must exist');
    assert.equal(policy!.fxEnabled, false, 'FX must fail closed by default');
    assert.equal(policy!.inversePermitted, false, 'inverse must fail closed by default');
  });

  it('returns nothing for a Client with no policy (absence is not permission)', async (t) => {
    if (!ready(t)) return;
    const clientId = await clientWithMonetaryContext();
    assert.equal(await clientFxPolicyRepository.findByClientId(clientId), null);
  });

  it('keeps one Client policy from affecting another', async (t) => {
    if (!ready(t)) return;
    const a = await clientWithMonetaryContext();
    const b = await clientWithMonetaryContext();
    await clientFxPolicyRepository.upsert({
      clientId: a, fxEnabled: true, reportingCurrencyCode: 'IDR',
      permittedSources: ['MANUAL_TREASURY'], inversePermitted: true, actorUserId: userId,
    });
    const policyA = await clientFxPolicyRepository.findByClientId(a);
    assert.equal(policyA!.fxEnabled, true);
    assert.equal(await clientFxPolicyRepository.findByClientId(b), null, 'Client B must stay fail-closed');
  });

  it('requires the reporting currency to equal the Client base currency', async (t) => {
    if (!ready(t)) return;
    const clientId = await clientWithMonetaryContext('IDR', ['IDR', 'USD']);
    await assert.rejects(
      clientFxPolicyRepository.upsert({
        clientId, fxEnabled: true, reportingCurrencyCode: 'USD',
        permittedSources: ['MANUAL_TREASURY'], inversePermitted: false, actorUserId: userId,
      }),
      'FX-01 does not add a second reporting axis',
    );
  });

  it('requires the reporting currency to be Client-allowed and ACTIVE', async (t) => {
    if (!ready(t)) return;
    const clientId = await clientWithMonetaryContext('IDR', ['IDR', 'USD']);
    await assert.rejects(
      clientFxPolicyRepository.upsert({
        clientId, fxEnabled: true, reportingCurrencyCode: 'EUR',
        permittedSources: ['MANUAL_TREASURY'], inversePermitted: false, actorUserId: userId,
      }),
      'an unallowed currency must not become a reporting target',
    );
  });

  it('rejects a permitted source outside the FX-01 vocabulary', async (t) => {
    if (!ready(t)) return;
    const clientId = await clientWithMonetaryContext();
    assert.equal(
      await sqlState(
        `INSERT INTO client_fx_policies (client_id, reporting_currency_code, permitted_sources,
           created_by_user_id, updated_by_user_id)
         VALUES ($1,'IDR',ARRAY['EXTERNAL_API'],$2,$2)`,
        [clientId, userId],
      ),
      '23514',
    );
  });

  it('rejects a non-positive staleness bound', async (t) => {
    if (!ready(t)) return;
    const clientId = await clientWithMonetaryContext();
    assert.equal(
      await sqlState(
        `INSERT INTO client_fx_policies (client_id, reporting_currency_code, permitted_sources,
           max_staleness_days, created_by_user_id, updated_by_user_id)
         VALUES ($1,'IDR',ARRAY['MANUAL_TREASURY'],0,$2,$2)`,
        [clientId, userId],
      ),
      '23514',
    );
  });
});

describe('CR-BE-FX-01 PART 01 — historical monetary authorities are untouched', () => {
  it('leaves legacy NULL currency snapshots NULL and unconverted', async (t) => {
    if (!ready(t)) return;
    const counts = await pool!.query<{ table_name: string; has_fx: boolean }>(`
      SELECT c.table_name,
             EXISTS (
               SELECT 1 FROM information_schema.columns k
               WHERE k.table_schema = 'public'
                 AND k.table_name = c.table_name
                 AND k.column_name IN ('converted_amount', 'fx_rate_id', 'reporting_amount')
             ) AS has_fx
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name IN (
          'vendor_service_costs','basic_expenses','tenant_charges','tenant_invoices',
          'tenant_invoice_lines','vendor_invoices','purchase_orders','price_catalog_entries',
          'operational_budgets','operational_commitments','utility_bills'
        )
      GROUP BY c.table_name
    `);
    assert.ok(counts.rows.length > 0, 'the monetary authorities must still exist');
    for (const row of counts.rows) {
      assert.equal(row.has_fx, false, `${row.table_name} must not have gained a converted-amount column`);
    }
  });

  it('leaves the Currency Master and operational_events schema unchanged', async (t) => {
    if (!ready(t)) return;
    const currencies = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM currencies`,
    );
    assert.equal(Number(currencies.rows[0]!.count), 9, 'the seeded master must be untouched');
    const nullable = await pool!.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'operational_events' AND column_name = 'client_id'
    `);
    assert.equal(nullable.rows[0]!.is_nullable, 'NO', 'operational_events.client_id must stay NOT NULL');
  });
});

describe('CR-BE-FX-01 PART 01 — migration is reversible', () => {
  // Runs LAST: it reverses 0333 through the real migrateDown/migrateUp path,
  // which keeps the migration registry consistent with the schema.
  it('migrateDown reverses 0333 with no residue, and migrateUp re-applies it', async (t) => {
    if (!ready(t)) return;
    try {
      // migrateDown runs the LAST applied migration's down() — which is 0333.
      const reversed = await migrateDown(pool!);
      assert.equal(reversed, '0333_create_fx_rate_authority_and_client_fx_policy');

      const residue = await pool!.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('fx_rates', 'fx_rate_events', 'client_fx_policies')
      `);
      assert.equal(Number(residue.rows[0]!.count), 0, 'down() must leave no FX tables behind');

      const functions = await pool!.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM pg_proc
        WHERE proname IN (
          'fx_rates_enforce_immutability', 'fx_rate_events_append_only', 'validate_client_fx_policy'
        )
      `);
      assert.equal(Number(functions.rows[0]!.count), 0, 'down() must leave no FX functions behind');
    } finally {
      // Always restore, so a mid-test failure cannot leave the database with a
      // registry that claims 0333 is applied while its tables are gone.
      const applied = await migrateUp(pool!);
      assert.ok(
        applied.includes('0333_create_fx_rate_authority_and_client_fx_policy'),
        'up() must be re-appliable after down()',
      );
      const restored = await pool!.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('fx_rates', 'fx_rate_events', 'client_fx_policies')
      `);
      assert.equal(Number(restored.rows[0]!.count), 3, 'all three FX authorities must be recreated');
    }
  });
});

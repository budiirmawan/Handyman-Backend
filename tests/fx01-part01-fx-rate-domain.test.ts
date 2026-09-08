import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  FX_RATE_EVENT_TYPES,
  FX_RATE_MAX_DECIMALS,
  FX_RATE_MAX_INTEGER_DIGITS,
  FX_RATE_NUMERIC_PRECISION,
  FX_RATE_NUMERIC_SCALE,
  FX_RATE_SOURCES,
  FX_RATE_STATUSES,
  FX_RATE_TERMINAL_STATUSES,
  FX_RATE_TRANSITIONS,
  FX_RATE_TYPES,
  isValidFxRateTransition,
} from '../src/modules/fx-rates/fx-rate.types';
import {
  inspectRateLiteral,
  validateClientFxPolicyInput,
  validateEffectiveWindow,
  validateNewFxRate,
  validateRateLiteral,
} from '../src/modules/fx-rates/fx-rate.validation';
import type { NewFxRate, UpsertClientFxPolicyInput } from '../src/modules/fx-rates/fx-rate.types';

/**
 * CR-BE-FX-01 PART 01 — FX Rate Authority domain invariants.
 *
 * These are the schema/domain invariants that do NOT require a database, so
 * they execute in any environment. The database-enforced invariants (foreign
 * keys, the GiST window exclusion, the immutability and append-only triggers,
 * the Client policy trigger) are covered by
 * `fx01-part01-fx-rate-authority.test.ts`, which skips when PostgreSQL is
 * unavailable.
 */

// Resolved from the repository root, which is the working directory of
// `npm test` (same convention as tests/audit-part05-openapi.test.ts).
const MIGRATION_PATH = resolve(
  'src/database/migrations/0333_create_fx_rate_authority_and_client_fx_policy.ts',
);
const FX_MODULE_PATH = resolve('src/modules/fx-rates');

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

function proposedRate(overrides: Partial<NewFxRate> = {}): NewFxRate {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    baseCurrencyCode: 'USD',
    quoteCurrencyCode: 'IDR',
    rate: '16500',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    source: 'MANUAL_TREASURY',
    createdByUserId: '00000000-0000-4000-8000-0000000000aa',
    ...overrides,
  };
}

function policy(overrides: Partial<UpsertClientFxPolicyInput> = {}): UpsertClientFxPolicyInput {
  return {
    clientId: '00000000-0000-4000-8000-0000000000bb',
    fxEnabled: true,
    reportingCurrencyCode: 'IDR',
    permittedSources: ['MANUAL_TREASURY'],
    inversePermitted: false,
    actorUserId: '00000000-0000-4000-8000-0000000000aa',
    ...overrides,
  };
}

describe('CR-BE-FX-01 PART 01 — canonical convention is frozen', () => {
  it('freezes 1 BASE = RATE x QUOTE and exposes no arithmetic', () => {
    const source = readFileSync(resolve(FX_MODULE_PATH, 'fx-rate.types.ts'), 'utf8');
    assert.match(source, /1 BASE = RATE x QUOTE/);
    assert.match(source, /1 USD = 16 500 IDR/);
    // PART 01 must not convert anything: no multiplication or division of an
    // amount by a rate may exist in the module yet.
    for (const file of ['fx-rate.types.ts', 'fx-rate.validation.ts', 'fx-rate.repository.ts']) {
      const body = readFileSync(resolve(FX_MODULE_PATH, file), 'utf8');
      assert.doesNotMatch(body, /amount\s*[*/]\s*rate/i, `${file} must not convert in PART 01`);
    }
  });

  it('declares NUMERIC(24,12) for the rate ratio', () => {
    assert.equal(FX_RATE_NUMERIC_PRECISION, 24);
    assert.equal(FX_RATE_NUMERIC_SCALE, 12);
    assert.equal(FX_RATE_MAX_DECIMALS, 12);
    assert.equal(FX_RATE_MAX_INTEGER_DIGITS, 12);
  });
});

describe('CR-BE-FX-01 PART 01 — currency pair invariants', () => {
  it('accepts a valid distinct BASE/QUOTE pair', () => {
    const rate = validateNewFxRate(proposedRate());
    assert.equal(rate.baseCurrencyCode, 'USD');
    assert.equal(rate.quoteCurrencyCode, 'IDR');
    assert.equal(rate.rate, '16500');
  });

  it('rejects BASE equal to QUOTE (no 1:1 identity rate is ever stored)', () => {
    assert.throws(
      () => validateNewFxRate(proposedRate({ quoteCurrencyCode: 'USD' })),
      (error: unknown) => codeOf(error) === 'FX_RATE_PAIR_IDENTICAL',
    );
  });

  it('rejects a currency code that is not the master three-letter identity', () => {
    for (const bad of ['usd', 'US', 'USDD', '', 'U$D']) {
      assert.throws(
        () => validateNewFxRate(proposedRate({ baseCurrencyCode: bad })),
        (error: unknown) => codeOf(error) === 'FX_RATE_CURRENCY_INACTIVE_OR_UNKNOWN',
        `expected '${bad}' to be rejected`,
      );
    }
  });
});

describe('CR-BE-FX-01 PART 01 — rate value invariants', () => {
  it('accepts a strictly positive decimal rate', () => {
    assert.equal(validateRateLiteral('16500'), '16500');
    assert.equal(validateRateLiteral('16500.25'), '16500.25');
    assert.equal(validateRateLiteral('0.000061538462'), '0.000061538462');
  });

  it('rejects zero and negative rates', () => {
    assert.throws(
      () => validateRateLiteral('0'),
      (error: unknown) => codeOf(error) === 'FX_RATE_INVALID_RATE',
    );
    assert.throws(
      () => validateRateLiteral('0.000000000000'),
      (error: unknown) => codeOf(error) === 'FX_RATE_INVALID_RATE',
    );
    assert.throws(
      () => validateRateLiteral('-16500'),
      (error: unknown) => codeOf(error) === 'FX_RATE_INVALID_RATE',
    );
  });

  it('rejects float-rendering and non-decimal input', () => {
    for (const bad of ['1e5', '1E5', 'NaN', 'Infinity', '16,500', '', 'abc', '0x10']) {
      assert.throws(
        () => validateRateLiteral(bad),
        (error: unknown) => codeOf(error) === 'FX_RATE_INVALID_RATE',
        `expected '${bad}' to be rejected`,
      );
    }
  });

  it('enforces the NUMERIC(24,12) digit capacity', () => {
    // 12 integer digits is the maximum; 13 overflows the column.
    assert.equal(validateRateLiteral('999999999999'), '999999999999');
    assert.throws(
      () => validateRateLiteral('9999999999999'),
      (error: unknown) => codeOf(error) === 'FX_RATE_INVALID_RATE',
    );
    // 12 decimals is the maximum; 13 would be silently rounded by the column.
    assert.equal(validateRateLiteral('0.123456789012'), '0.123456789012');
    assert.throws(
      () => validateRateLiteral('0.1234567890123'),
      (error: unknown) => codeOf(error) === 'FX_RATE_INVALID_RATE',
    );
  });

  it('inspects decimal digits without passing the value through a float', () => {
    const inspected = inspectRateLiteral('000000000016500.50');
    assert.equal(inspected.integerDigits, 5, 'leading zeros must not consume capacity');
    assert.equal(inspected.decimalDigits, 2);
    assert.equal(inspected.isPositive, true);
    assert.equal(inspected.canonical, '16500.50');
  });
});

describe('CR-BE-FX-01 PART 01 — rate type and source vocabulary', () => {
  it('supports REFERENCE only', () => {
    assert.deepEqual([...FX_RATE_TYPES], ['REFERENCE']);
    assert.equal(validateNewFxRate(proposedRate()).rateType, 'REFERENCE');
  });

  it('rejects SPOT, DAILY, MONTH_END, ACCOUNTING and CONTRACTUAL', () => {
    for (const rejected of ['SPOT', 'DAILY', 'MONTH_END', 'ACCOUNTING', 'CONTRACTUAL']) {
      assert.ok(!FX_RATE_TYPES.includes(rejected as never), `${rejected} must not be supported`);
    }
  });

  it('supports MANUAL_TREASURY only — no provider ingestion exists', () => {
    assert.deepEqual([...FX_RATE_SOURCES], ['MANUAL_TREASURY']);
    assert.throws(
      () => validateNewFxRate(proposedRate({ source: 'BANK_INDONESIA' as never })),
      (error: unknown) => codeOf(error) === 'FX_RATE_SOURCE_UNSUPPORTED',
    );
  });
});

describe('CR-BE-FX-01 PART 01 — frozen lifecycle model', () => {
  it('declares the governed status vocabulary', () => {
    assert.deepEqual([...FX_RATE_STATUSES], [
      'PENDING_APPROVAL',
      'ACTIVE',
      'REJECTED',
      'SUPERSEDED',
      'INACTIVE',
    ]);
    assert.deepEqual([...FX_RATE_TERMINAL_STATUSES], ['REJECTED', 'SUPERSEDED', 'INACTIVE']);
  });

  it('allows only PENDING_APPROVAL -> ACTIVE|REJECTED and ACTIVE -> SUPERSEDED|INACTIVE', () => {
    assert.equal(isValidFxRateTransition('PENDING_APPROVAL', 'ACTIVE'), true);
    assert.equal(isValidFxRateTransition('PENDING_APPROVAL', 'REJECTED'), true);
    assert.equal(isValidFxRateTransition('ACTIVE', 'SUPERSEDED'), true);
    assert.equal(isValidFxRateTransition('ACTIVE', 'INACTIVE'), true);
  });

  it('rejects every other transition, including resurrection from a terminal state', () => {
    assert.equal(isValidFxRateTransition('PENDING_APPROVAL', 'SUPERSEDED'), false);
    assert.equal(isValidFxRateTransition('PENDING_APPROVAL', 'INACTIVE'), false);
    assert.equal(isValidFxRateTransition('ACTIVE', 'PENDING_APPROVAL'), false);
    assert.equal(isValidFxRateTransition('ACTIVE', 'REJECTED'), false);
    for (const terminal of FX_RATE_TERMINAL_STATUSES) {
      assert.deepEqual(FX_RATE_TRANSITIONS[terminal], [], `${terminal} must be terminal`);
      for (const target of FX_RATE_STATUSES) {
        assert.equal(isValidFxRateTransition(terminal, target), false);
      }
    }
  });

  it('declares the append-only rate audit vocabulary', () => {
    assert.deepEqual([...FX_RATE_EVENT_TYPES], [
      'FX_RATE_CREATED',
      'FX_RATE_APPROVED',
      'FX_RATE_REJECTED',
      'FX_RATE_SUPERSEDED',
      'FX_RATE_DEACTIVATED',
    ]);
  });
});

describe('CR-BE-FX-01 PART 01 — effective window is closed-open', () => {
  it('accepts an open-ended window', () => {
    const window = validateEffectiveWindow('2026-01-01T00:00:00.000Z', null);
    assert.equal(window.effectiveTo, null);
  });

  it('accepts a future effectiveFrom (scheduling is not an error)', () => {
    const window = validateEffectiveWindow('2030-01-01T00:00:00.000Z', null);
    assert.ok(window.effectiveFrom.getTime() > Date.now());
  });

  it('rejects effectiveTo <= effectiveFrom', () => {
    assert.throws(
      () => validateEffectiveWindow('2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      (error: unknown) => codeOf(error) === 'FX_RATE_WINDOW_INVALID',
      'equal bounds must be rejected: [from, to) would be empty',
    );
    assert.throws(
      () => validateEffectiveWindow('2026-06-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
      (error: unknown) => codeOf(error) === 'FX_RATE_WINDOW_INVALID',
    );
  });

  it('rejects an unparseable bound', () => {
    assert.throws(
      () => validateEffectiveWindow('not-a-date', null),
      (error: unknown) => codeOf(error) === 'FX_RATE_WINDOW_INVALID',
    );
  });
});

describe('CR-BE-FX-01 PART 01 — Client FX policy invariants', () => {
  it('defaults inverse to false and never widens it implicitly', () => {
    const withInverse = validateClientFxPolicyInput(policy({ inversePermitted: true }));
    assert.equal(withInverse.inversePermitted, true);
    const omitted = validateClientFxPolicyInput({ ...policy(), inversePermitted: undefined as never });
    assert.equal(omitted.inversePermitted, false, 'absent must fail closed to false');
  });

  it('defaults fxEnabled to false when not explicitly true', () => {
    const result = validateClientFxPolicyInput({ ...policy(), fxEnabled: undefined as never });
    assert.equal(result.fxEnabled, false);
  });

  it('accepts only permitted sources known to FX-01 and de-duplicates them', () => {
    const result = validateClientFxPolicyInput(
      policy({ permittedSources: ['MANUAL_TREASURY', 'MANUAL_TREASURY'] }),
    );
    assert.deepEqual(result.permittedSources, ['MANUAL_TREASURY']);
    assert.throws(
      () => validateClientFxPolicyInput(policy({ permittedSources: ['EXTERNAL_API' as never] })),
      (error: unknown) => codeOf(error) === 'FX_POLICY_SOURCE_UNSUPPORTED',
    );
  });

  it('accepts an empty permitted-source set (permits nothing) without failing', () => {
    const result = validateClientFxPolicyInput(policy({ permittedSources: [] }));
    assert.deepEqual(result.permittedSources, []);
  });

  it('rejects a non-positive or fractional staleness bound', () => {
    for (const bad of [0, -1, 1.5]) {
      assert.throws(
        () => validateClientFxPolicyInput(policy({ maxStalenessDays: bad })),
        (error: unknown) => codeOf(error) === 'FX_POLICY_STALENESS_INVALID',
        `expected ${bad} to be rejected`,
      );
    }
    assert.equal(validateClientFxPolicyInput(policy({ maxStalenessDays: null })).maxStalenessDays, null);
    assert.equal(validateClientFxPolicyInput(policy({ maxStalenessDays: 30 })).maxStalenessDays, 30);
  });

  it('rejects a malformed reporting currency code', () => {
    assert.throws(
      () => validateClientFxPolicyInput(policy({ reportingCurrencyCode: 'idr' })),
      (error: unknown) => codeOf(error) === 'FX_POLICY_REPORTING_CURRENCY_INVALID',
    );
  });
});

describe('CR-BE-FX-01 PART 01 — historical monetary authorities are untouched', () => {
  const migration = readFileSync(MIGRATION_PATH, 'utf8');

  /**
   * The migration legitimately *names* some authorities inside explanatory
   * comments (e.g. why `fx_rate_events` exists rather than weakening
   * `operational_events`). What matters is the executable SQL, so comments are
   * stripped before asserting on referenced tables.
   */
  const sql = migration
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\s\/\/.*$/, '').replace(/\s--.*$/, ''))
    .join('\n');

  it('alters no table except adding its own window-exclusion constraint', () => {
    const altered = [...sql.matchAll(/ALTER TABLE\s+([a-z_]+)/gi)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(altered)],
      ['fx_rates'],
      'migration 0333 must not ALTER any pre-existing table',
    );
  });

  it('performs no backfill, no rewrite and no defaulting of existing data', () => {
    for (const forbidden of [/\bUPDATE\s+[a-z_]+\s+SET/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
      assert.doesNotMatch(sql, forbidden, 'migration 0333 must not mutate existing data');
    }
  });

  it('does not touch any monetary snapshot column', () => {
    for (const monetary of [
      'vendor_service_costs',
      'basic_expenses',
      'tenant_charges',
      'tenant_invoices',
      'tenant_invoice_lines',
      'vendor_invoices',
      'purchase_orders',
      'price_catalog_entries',
      'operational_budgets',
      'operational_commitments',
      'operational_commitment_entries',
      'utility_bills',
      'utility_calculations',
      'utility_calculation_bases',
      'inventory_work_order_material_usages',
    ]) {
      assert.ok(
        !sql.includes(monetary),
        `migration 0333 must not reference monetary authority '${monetary}'`,
      );
    }
  });

  it('does not weaken operational_events to make room for platform-global audit', () => {
    assert.ok(
      !sql.includes('operational_events'),
      'operational_events.client_id NOT NULL must stay intact',
    );
    assert.match(sql, /CREATE TABLE fx_rate_events/);
  });

  it('does not consume migration 0334', () => {
    assert.equal(
      existsSync(resolve('src/database/migrations/0334_create_fx_conversion_ledger.ts')),
      false,
      'the conversion ledger belongs to PART 03 and must not exist yet',
    );
  });

  it('references the existing Currency Master instead of duplicating it', () => {
    assert.match(migration, /base_currency_code\s+VARCHAR\(3\) NOT NULL REFERENCES currencies \(code\)/);
    assert.match(migration, /quote_currency_code\s+VARCHAR\(3\) NOT NULL REFERENCES currencies \(code\)/);
    assert.doesNotMatch(migration, /CREATE TABLE currencies/);
  });

  it('stores the rate as NUMERIC(24,12) with a positivity constraint', () => {
    assert.match(migration, /rate\s+NUMERIC\(24, 12\) NOT NULL/);
    assert.match(migration, /fx_rates_rate_positive_check CHECK \(rate > 0\)/);
    assert.match(migration, /fx_rates_pair_distinct_check CHECK \(\s*base_currency_code <> quote_currency_code/);
  });
});

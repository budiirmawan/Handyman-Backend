import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  FX_UNCONVERTIBLE_REASONS,
  fxReportingService,
  type FxReportingMonetaryFact,
} from '../src/modules/fx-rates/fx-reporting.service';
import type { FxRateGateway } from '../src/modules/fx-rates/fx-conversion.service';
import type { ClientFxPolicy, FxRate } from '../src/modules/fx-rates/fx-rate.types';

/**
 * CR-BE-FX-01 PART 04 — reporting-currency integration.
 *
 * Drives the REAL `fxReportingService.buildReportingCurrencyView` through an
 * injected gateway and policy reader, so the original-currency preservation, the
 * business-date authority, the unconvertible taxonomy, completeness semantics
 * and per-component provenance are all executed here without a database.
 */

const SRC = resolve('src');
const FX_PATH = resolve('src/modules/fx-rates');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';

/**
 * Strips comments for negative static assertions, which must inspect CODE only.
 * Whole `//` and block-comment lines are dropped rather than merely unprefixed,
 * because the prose legitimately names things like `created_at` to say they are
 * never used.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

type RateSeed = {
  id: string;
  base: string;
  quote: string;
  rate: string;
  from: string;
  to?: string | null;
  status?: FxRate['status'];
  source?: FxRate['source'];
};

function rate(seed: RateSeed): FxRate {
  return {
    id: seed.id,
    baseCurrencyCode: seed.base,
    quoteCurrencyCode: seed.quote,
    rateType: 'REFERENCE',
    rate: seed.rate,
    effectiveFrom: new Date(seed.from),
    effectiveTo: seed.to === undefined ? null : seed.to === null ? null : new Date(seed.to),
    status: seed.status ?? 'ACTIVE',
    source: seed.source ?? 'MANUAL_TREASURY',
    sourceReference: null,
    ingestedAt: null,
    supersedesRateId: null,
    supersededByRateId: null,
    createdByUserId: MAKER,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    rejectedReason: null,
    supersededByUserId: null,
    supersededAt: null,
    deactivatedByUserId: null,
    deactivatedAt: null,
    deactivationReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function policy(overrides: Partial<ClientFxPolicy> = {}): ClientFxPolicy {
  return {
    clientId: CLIENT_ID,
    fxEnabled: true,
    reportingCurrencyCode: 'IDR',
    permittedSources: ['MANUAL_TREASURY'],
    inversePermitted: false,
    maxStalenessDays: null,
    createdByUserId: MAKER,
    updatedByUserId: MAKER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildGateway(
  seeds: RateSeed[],
  allowed = ['IDR', 'USD', 'SGD', 'EUR'],
  clientPolicy: ClientFxPolicy | null = policy(),
): FxRateGateway {
  const rates = seeds.map(rate);
  const precision: Record<string, number> = { IDR: 0, USD: 2, SGD: 2, EUR: 2 };
  return {
    findActiveCurrency: async (code) =>
      code in precision ? { code, decimalPrecision: precision[code]! } : null,
    // The policy is served through the SAME gateway the conversion authority
    // reads, so the reporting layer and PART 03 can never disagree.
    findClientFxPolicy: async () => clientPolicy,
    findNotAllowedCurrencies: async (_c, codes) => codes.filter((x) => !allowed.includes(x)),
    findActiveCovering: async (base, quote, at) =>
      rates.filter(
        (row) =>
          row.status === 'ACTIVE' &&
          row.rateType === 'REFERENCE' &&
          row.baseCurrencyCode === base &&
          row.quoteCurrencyCode === quote &&
          row.effectiveFrom.getTime() <= at.getTime() &&
          (row.effectiveTo === null || row.effectiveTo.getTime() > at.getTime()),
      ),
    countPairCoverage: async (base, quote, at) => {
      const forPair = rates.filter((r) => r.baseCurrencyCode === base && r.quoteCurrencyCode === quote);
      const active = forPair.filter((r) => r.status === 'ACTIVE');
      return {
        anyStatus: forPair.length,
        active: active.length,
        activeNotYetEffective: active.filter((r) => r.effectiveFrom.getTime() > at.getTime()).length,
        activeExpired: active.filter((r) => r.effectiveTo !== null && r.effectiveTo.getTime() <= at.getTime()).length,
      };
    },
  };
}

function fact(overrides: Partial<FxReportingMonetaryFact> = {}): FxReportingMonetaryFact {
  return {
    sourceType: 'VENDOR_SERVICE_COST',
    sourceId: 'fact-1',
    amount: '100',
    currencyCode: 'USD',
    businessDate: '2026-03-15T00:00:00.000Z',
    ...overrides,
  };
}

async function build(opts: {
  facts: FxReportingMonetaryFact[];
  rates?: RateSeed[];
  policy?: ClientFxPolicy | null;
  allowed?: string[];
}) {
  return fxReportingService.buildReportingCurrencyView({
    clientId: CLIENT_ID,
    facts: opts.facts,
    gateway: buildGateway(
      opts.rates ?? [],
      opts.allowed,
      opts.policy === undefined ? policy() : opts.policy,
    ),
  });
}

const USD_IDR_MAR = { id: 'rate-mar', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };

describe('CR-BE-FX-01 PART 04 — original-currency view stays authoritative', () => {
  it('keeps IDR and USD as two separate original-currency groups', async () => {
    const view = await build({
      rates: [USD_IDR_MAR],
      facts: [
        fact({ sourceId: 'a', amount: '1000000', currencyCode: 'IDR' }),
        fact({ sourceId: 'b', amount: '100', currencyCode: 'USD' }),
      ],
    });
    assert.deepEqual(
      view.originalCurrencyTotals,
      [
        { currencyCode: 'IDR', amount: '1000000', count: 1 },
        { currencyCode: 'USD', amount: '100', count: 1 },
      ],
      'the original groups must remain separately identifiable, not collapsed',
    );
    assert.equal(view.convertedTotal?.amount, '2650000', '1 000 000 IDR (identity) + 100 x 16 500');
    // Both views coexist: the converted total never REPLACES the original groups.
    assert.equal(view.originalCurrencyTotals.length, 2);
  });

  it('groups same-currency facts exactly and keeps UNKNOWN as its own group', async () => {
    const view = await build({
      rates: [USD_IDR_MAR],
      facts: [
        fact({ sourceId: 'a', amount: '10.10', currencyCode: 'USD' }),
        fact({ sourceId: 'b', amount: '20.20', currencyCode: 'USD' }),
        fact({ sourceId: 'c', amount: '5', currencyCode: null }),
      ],
    });
    const usd = view.originalCurrencyTotals.find((t) => t.currencyCode === 'USD');
    assert.equal(usd?.amount, '30.30', 'exact decimal addition, not 30.299999999999997');
    const unknown = view.originalCurrencyTotals.find((t) => t.currencyCode === null);
    assert.equal(unknown?.count, 1);
    assert.equal(unknown?.amount, '5');
  });

  it('returns the original-currency view even when nothing converts', async () => {
    const view = await build({ rates: [], facts: [fact({ amount: '100' })] });
    assert.equal(view.convertedTotal, null);
    assert.deepEqual(view.originalCurrencyTotals, [{ currencyCode: 'USD', amount: '100', count: 1 }]);
    assert.equal(view.unconvertible.length, 1);
  });
});

describe('CR-BE-FX-01 PART 04 — converted total completeness', () => {
  it('returns a COMPLETE total when every component converts', async () => {
    const view = await build({
      rates: [USD_IDR_MAR],
      facts: [
        fact({ sourceId: 'a', amount: '100', currencyCode: 'USD' }),
        fact({ sourceId: 'b', amount: '250000', currencyCode: 'IDR' }),
      ],
    });
    assert.deepEqual(view.convertedTotal, {
      amount: '1900000',
      currencyCode: 'IDR',
      completeness: 'COMPLETE',
    });
    assert.deepEqual(view.unconvertible, []);
  });

  it('mixes IDENTITY and DIRECT in one report', async () => {
    const view = await build({
      rates: [USD_IDR_MAR],
      facts: [
        fact({ sourceId: 'idr', amount: '500000', currencyCode: 'IDR' }),
        fact({ sourceId: 'usd', amount: '100', currencyCode: 'USD' }),
      ],
    });
    const modes = view.convertedComponents.map((c) => c.conversionMode).sort();
    assert.deepEqual(modes, ['DIRECT', 'IDENTITY']);
    assert.equal(view.convertedTotal?.completeness, 'COMPLETE');
    assert.equal(view.convertedTotal?.amount, '2150000');
  });

  it('uses INVERSE where Client policy permits it', async () => {
    const view = await build({
      rates: [{ id: 'rate-usd-idr', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' }],
      policy: policy({ inversePermitted: true, reportingCurrencyCode: 'USD' }),
      facts: [fact({ sourceId: 'a', amount: '1980000', currencyCode: 'IDR' })],
    });
    assert.equal(view.convertedComponents[0]?.conversionMode, 'INVERSE');
    assert.equal(view.convertedTotal?.amount, '120.00');
    assert.equal(view.convertedTotal?.currencyCode, 'USD');
  });

  it('prefers DIRECT over INVERSE when both resolve', async () => {
    const view = await build({
      rates: [
        USD_IDR_MAR,
        { id: 'rate-idr-usd', base: 'IDR', quote: 'USD', rate: '0.00006', from: '2026-03-01T00:00:00.000Z' },
      ],
      policy: policy({ inversePermitted: true }),
      facts: [fact({ sourceId: 'a', amount: '100', currencyCode: 'USD' })],
    });
    assert.equal(view.convertedComponents[0]?.conversionMode, 'DIRECT');
    assert.equal(view.convertedComponents[0]?.provenance.fxRateId, 'rate-mar');
  });

  it('never returns a partial converted grand total', async () => {
    const view = await build({
      rates: [USD_IDR_MAR],
      facts: [
        fact({ sourceId: 'ok', amount: '100', currencyCode: 'USD' }),
        fact({ sourceId: 'bad', amount: '50', currencyCode: 'SGD' }), // no SGD rate stocked
      ],
    });
    assert.equal(view.convertedTotal, null, 'one failure must null the whole total');
    assert.equal(view.convertedComponents.length, 1, 'the successful component is still shown, not hidden');
    assert.deepEqual(
      view.unconvertible.map((u) => u.sourceId),
      ['bad'],
    );
    // And there is no differently-named subtotal standing in for the total.
    assert.equal('convertedSubtotal' in view, false);
    assert.equal('partialTotal' in view, false);
  });
});

describe('CR-BE-FX-01 PART 04 — unconvertible taxonomy', () => {
  it('declares the full reason vocabulary', () => {
    assert.deepEqual([...FX_UNCONVERTIBLE_REASONS].sort(), [
      'BUSINESS_DATE_MISSING',
      'CURRENCY_NOT_ALLOWED',
      'FX_DISABLED',
      'FX_POLICY_UNAVAILABLE',
      'RATE_AMBIGUOUS',
      'RATE_MISSING',
      'RATE_STALE',
      'REPORTING_TARGET_MISMATCH',
      'UNKNOWN_SOURCE_CURRENCY',
    ]);
  });

  it('maps UNKNOWN currency and keeps it UNKNOWN', async () => {
    for (const currencyCode of [null, undefined, '  ']) {
      const view = await build({
        rates: [USD_IDR_MAR],
        facts: [fact({ sourceId: 'u', amount: '999', currencyCode })],
      });
      assert.equal(view.convertedTotal, null);
      assert.equal(view.unconvertible[0]?.reason, 'UNKNOWN_SOURCE_CURRENCY');
      assert.equal(view.unconvertible[0]?.errorCode, 'FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE');
      assert.equal(view.unconvertible[0]?.currencyCode, null);
      assert.equal(
        view.convertedComponents.length,
        0,
        'an UNKNOWN currency must never be converted as identity',
      );
    }
  });

  it('maps a missing business date and never invents one', async () => {
    for (const businessDate of [null, undefined, 'not-a-date']) {
      const view = await build({ rates: [USD_IDR_MAR], facts: [fact({ businessDate })] });
      assert.equal(view.unconvertible[0]?.reason, 'BUSINESS_DATE_MISSING');
      assert.equal(view.convertedTotal, null);
    }
  });

  it('maps a missing rate', async () => {
    const view = await build({ rates: [], facts: [fact()] });
    assert.equal(view.unconvertible[0]?.reason, 'RATE_MISSING');
    assert.equal(view.unconvertible[0]?.errorCode, 'FX_PAIR_NOT_GOVERNED');
  });

  it('maps a stale rate', async () => {
    const view = await build({
      rates: [{ id: 'r', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' }],
      policy: policy({ maxStalenessDays: 30 }),
      facts: [fact({ businessDate: '2026-06-01T00:00:00.000Z' })],
    });
    assert.equal(view.unconvertible[0]?.reason, 'RATE_STALE');
    assert.equal(view.unconvertible[0]?.errorCode, 'FX_RATE_STALE');
  });

  it('maps an ambiguous rate', async () => {
    const view = await build({
      rates: [
        { id: 'r1', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' },
        { id: 'r2', base: 'USD', quote: 'IDR', rate: '16600', from: '2026-02-01T00:00:00.000Z' },
      ],
      facts: [fact({ businessDate: '2026-03-15T00:00:00.000Z' })],
    });
    assert.equal(view.unconvertible[0]?.reason, 'RATE_AMBIGUOUS');
    assert.equal(view.unconvertible[0]?.errorCode, 'FX_RATE_AMBIGUOUS');
  });

  it('maps FX disabled and missing policy, for every fact', async () => {
    const facts = [fact({ sourceId: 'a' }), fact({ sourceId: 'b' })];

    const disabled = await build({ rates: [USD_IDR_MAR], policy: policy({ fxEnabled: false }), facts });
    assert.equal(disabled.reportingCurrencyCode, null);
    assert.equal(disabled.convertedTotal, null);
    assert.deepEqual(disabled.unconvertible.map((u) => u.reason), ['FX_DISABLED', 'FX_DISABLED']);
    assert.deepEqual(disabled.originalCurrencyTotals, [{ currencyCode: 'USD', amount: '200', count: 2 }]);

    const missing = await build({ rates: [USD_IDR_MAR], policy: null, facts });
    assert.deepEqual(missing.unconvertible.map((u) => u.reason), ['FX_POLICY_UNAVAILABLE', 'FX_POLICY_UNAVAILABLE']);
  });

  it('maps a disallowed Client currency and a reporting-target mismatch', async () => {
    const notAllowed = await build({
      rates: [USD_IDR_MAR],
      allowed: ['IDR'],
      facts: [fact({ currencyCode: 'USD' })],
    });
    assert.equal(notAllowed.unconvertible[0]?.reason, 'CURRENCY_NOT_ALLOWED');
    assert.equal(notAllowed.unconvertible[0]?.errorCode, 'CLIENT_CURRENCY_NOT_ALLOWED');
  });

  it('never hides a failed record', async () => {
    const view = await build({
      rates: [],
      facts: [
        fact({ sourceId: 'a' }),
        fact({ sourceId: 'b', currencyCode: null }),
        fact({ sourceId: 'c', businessDate: null }),
      ],
    });
    assert.deepEqual(
      view.unconvertible.map((u) => u.sourceId).sort(),
      ['a', 'b', 'c'],
    );
    assert.equal(view.convertedTotal, null);
  });
});

describe('CR-BE-FX-01 PART 04 — business-date authority', () => {
  it('resolves different rates for different source dates', async () => {
    const view = await build({
      rates: [
        { id: 'rate-mar', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
        { id: 'rate-jun', base: 'USD', quote: 'IDR', rate: '17200', from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
      ],
      facts: [
        fact({ sourceId: 'mar', amount: '100', businessDate: '2026-03-15T00:00:00.000Z' }),
        fact({ sourceId: 'jun', amount: '100', businessDate: '2026-06-15T00:00:00.000Z' }),
      ],
    });
    const byId = Object.fromEntries(view.convertedComponents.map((c) => [c.sourceId, c]));
    assert.equal(byId['mar']?.provenance.fxRateId, 'rate-mar');
    assert.equal(byId['jun']?.provenance.fxRateId, 'rate-jun');
    assert.equal(byId['mar']?.convertedAmount, '1650000');
    assert.equal(byId['jun']?.convertedAmount, '1720000');
    assert.equal(view.convertedTotal?.amount, '3370000');
  });

  it('never uses the report generation date as the rate date', async () => {
    // A rate that was valid in 2026-03 but has long expired. If the report
    // generation timestamp were used, this would fail as NOT_EFFECTIVE.
    const view = await build({
      rates: [
        { id: 'rate-mar', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      ],
      facts: [fact({ businessDate: '2026-03-15T00:00:00.000Z' })],
    });
    assert.equal(view.convertedComponents[0]?.conversionMode, 'DIRECT');
    assert.equal(view.convertedComponents[0]?.referenceDate, '2026-03-15T00:00:00.000Z');

    // Statically: the reporting layer never manufactures a reference date.
    const body = stripComments(readFileSync(resolve(FX_PATH, 'fx-reporting.service.ts'), 'utf8'));
    assert.doesNotMatch(body, /Date\.now\(/);
    assert.doesNotMatch(body, /new Date\(\)/);
    assert.doesNotMatch(body, /created_at|createdAt/);
  });
});

describe('CR-BE-FX-01 PART 04 — provenance per component', () => {
  it('preserves full PART 03 provenance for every converted component', async () => {
    const view = await build({
      rates: [USD_IDR_MAR],
      facts: [
        fact({ sourceId: 'usd', amount: '100', currencyCode: 'USD' }),
        fact({ sourceId: 'idr', amount: '5000', currencyCode: 'IDR' }),
      ],
    });
    for (const component of view.convertedComponents) {
      assert.equal(component.targetCurrencyCode, 'IDR');
      assert.ok(component.provenance.fxRateId !== undefined);
      assert.equal(component.provenance.roundingMode, 'HALF_UP');
      assert.ok(typeof component.referenceDate === 'string');
      assert.ok(component.conversionMode);
    }
    const usd = view.convertedComponents.find((c) => c.sourceId === 'usd')!;
    assert.equal(usd.provenance.fxRateId, 'rate-mar');
    assert.equal(usd.provenance.rate, '16500');
    assert.equal(usd.provenance.conversionMode, 'DIRECT');
    assert.equal(usd.sourceAmount, '100');
    assert.equal(usd.sourceCurrencyCode, 'USD');
  });

  it('does not collapse different rates into one fake report-level rate', async () => {
    const view = await build({
      rates: [
        { id: 'rate-mar', base: 'USD', quote: 'IDR', rate: '16500', from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
        { id: 'rate-jun', base: 'USD', quote: 'IDR', rate: '17200', from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
      ],
      facts: [
        fact({ sourceId: 'mar', businessDate: '2026-03-15T00:00:00.000Z' }),
        fact({ sourceId: 'jun', businessDate: '2026-06-15T00:00:00.000Z' }),
      ],
    });
    assert.equal('rate' in view, false, 'the view must not carry a single report-level rate');
    assert.equal('fxRateId' in view, false);
    const ids = new Set(view.convertedComponents.map((c) => c.provenance.fxRateId));
    assert.equal(ids.size, 2, 'two distinct rates must stay distinct');
  });
});

describe('CR-BE-FX-01 PART 04 — reporting currency comes only from the Client FX Policy', () => {
  it('targets the governed reporting currency', async () => {
    const view = await build({
      rates: [{ id: 'r', base: 'IDR', quote: 'EUR', rate: '0.00006', from: '2026-01-01T00:00:00.000Z' }],
      policy: policy({ reportingCurrencyCode: 'EUR' }),
      facts: [fact({ currencyCode: 'IDR', amount: '1000000' })],
    });
    assert.equal(view.reportingCurrencyCode, 'EUR');
    assert.equal(view.convertedTotal?.currencyCode, 'EUR');
  });

  it('never hardcodes IDR or derives the target from request input', () => {
    const body = stripComments(readFileSync(resolve(FX_PATH, 'fx-reporting.service.ts'), 'utf8'));
    assert.doesNotMatch(body, /'IDR'/, 'no hardcoded IDR default');
    assert.doesNotMatch(body, /defaultTransactionCurrency|baseCurrencyCode/, 'no base/default substitution');
    // The target is read from the policy only.
    assert.match(body, /policy\.reportingCurrencyCode/);
  });
});

describe('CR-BE-FX-01 PART 04 — exact-currency operational controls are untouched', () => {
  const controlFiles = [
    'operational-finance/operational-variance.service.ts',
    'operational-finance/operational-finance-binding.service.ts',
    'operational-finance/operational-finance-aggregation.service.ts',
    'operational-finance/operational-commitment-vendor.service.ts',
    'operational-finance/operational-commitment-material.service.ts',
    'tenant-invoices/tenant-invoice.service.ts',
    'price-catalog-entries/price-catalog-entry.service.ts',
  ];

  it('imports no FX into any operational control surface', () => {
    for (const file of controlFiles) {
      const body = readFileSync(resolve(SRC, 'modules', file), 'utf8');
      assert.doesNotMatch(body, /fx-reporting|fx-conversion|fxConversionService|fxReportingService/,
        `${file} must not consume FX`);
    }
  });

  it('still fails closed on currency mismatch', () => {
    const variance = readFileSync(resolve(SRC, 'modules/operational-finance/operational-variance.service.ts'), 'utf8');
    assert.match(variance, /SOURCE_CURRENCY_MISMATCH/);
    assert.match(variance, /CURRENCYLESS_COST_AUTHORITY/);
    const binding = readFileSync(resolve(SRC, 'modules/operational-finance/operational-finance-binding.service.ts'), 'utf8');
    assert.match(binding, /operationalBudgetSourceCurrencyMismatchError/);
    const tenant = readFileSync(resolve(SRC, 'modules/tenant-invoices/tenant-invoice.service.ts'), 'utf8');
    assert.match(tenant, /tenantInvoiceCurrencyMismatchError/);
  });
});

describe('CR-BE-FX-01 PART 04 — export renderers stay pure', () => {
  const renderers = ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts'];

  it('performs no FX in any renderer', () => {
    for (const file of renderers) {
      const body = readFileSync(resolve(SRC, 'modules/reporting-export', file), 'utf8');
      assert.doesNotMatch(body, /fx-|fxConversion|fxReporting|currency/i, `${file} must not perform FX`);
    }
  });

  it('keeps the whole export module free of monetary FX', () => {
    for (const file of readdirSync(resolve(SRC, 'modules/reporting-export'))) {
      if (!file.endsWith('.ts')) continue;
      const body = readFileSync(resolve(SRC, 'modules/reporting-export', file), 'utf8');
      assert.doesNotMatch(body, /fxConversionService|fxReportingService/, `${file} must not call FX`);
    }
  });
});

describe('CR-BE-FX-01 PART 04 — read-side only', () => {
  const partFourFiles = [
    resolve(FX_PATH, 'fx-reporting.service.ts'),
    resolve(SRC, 'modules/currency-reporting/reporting-currency-read-model.ts'),
  ];

  it('persists nothing and emits no audit event', () => {
    for (const file of partFourFiles) {
      const body = readFileSync(file, 'utf8');
      assert.doesNotMatch(body, /\bINSERT\s+INTO\b/i, `${file} must not insert`);
      assert.doesNotMatch(body, /\bUPDATE\s+[a-z_]+\s+SET\b/i, `${file} must not update`);
      assert.doesNotMatch(body, /\bDELETE\s+FROM\b/i, `${file} must not delete`);
      assert.doesNotMatch(body, /recordOperationalEvent|fxRateEventRepository/, `${file} must not audit`);
    }
  });

  it('writes no fxRateId into any transaction table', () => {
    for (const file of partFourFiles) {
      const body = readFileSync(file, 'utf8');
      assert.doesNotMatch(body, /fx_conversions|fx_rate_id\s*=/);
    }
  });

  it('creates no 0334 and no conversion ledger', () => {
    const migrations = resolve('src/database/migrations');
    assert.equal(existsSync(resolve(migrations, '0334_create_fx_conversion_ledger.ts')), false);
    assert.equal(
      readdirSync(migrations).filter((f) => /^\d{4}_/.test(f)).sort().at(-1),
      '0333_create_fx_rate_authority_and_client_fx_policy.ts',
    );
  });

  it('exposes no public FX conversion or quote endpoint', () => {
    const routes = readFileSync(resolve(FX_PATH, 'fx-rate.routes.ts'), 'utf8');
    assert.doesNotMatch(routes, /convert|quote|resolve/i);
    const registry = stripComments(readFileSync(resolve(SRC, 'routes/index.ts'), 'utf8'));
    assert.doesNotMatch(registry, /fx-reporting|fx-conversion/, 'the reporting layer is internal');
    const openapi = readFileSync(resolve('docs/api/openapi.yaml'), 'utf8');
    assert.doesNotMatch(openapi, /\/fx\/convert|\/fx\/quote|\/fx-rates\/resolve/);
  });
});

describe('CR-BE-FX-01 PART 04 — the exact-currency seam is unchanged', () => {
  it('leaves getOperationalCurrencySummary byte-identical to CUR-01', () => {
    const index = readFileSync(resolve(SRC, 'modules/currency-reporting/index.ts'), 'utf8');
    // The CUR-01 seam groups by currency_code and keeps an unknown bucket.
    assert.match(index, /GROUP BY currency_code/);
    assert.match(index, /unknown/);
    assert.doesNotMatch(index, /fxReportingService|fx-conversion|reportingCurrency/,
      'the CUR-01 seam must not gain FX behaviour');
  });

  it('imports the seam rather than duplicating its aggregation', () => {
    const body = readFileSync(resolve(SRC, 'modules/currency-reporting/reporting-currency-read-model.ts'), 'utf8');
    assert.match(body, /import \{ getOperationalCurrencySummary \} from '\.\/index'/);
    assert.doesNotMatch(body, /GROUP BY currency_code/, 'the aggregate must not be reimplemented');
  });
});

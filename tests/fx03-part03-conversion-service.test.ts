import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  fxConversionService,
  FX_ROUNDING_MODE,
  type FxConversionRequest,
  type FxPairCoverage,
  type FxRateGateway,
} from '../src/modules/fx-rates/fx-conversion.service';
import type { ClientFxPolicy, FxRate } from '../src/modules/fx-rates/fx-rate.types';

/**
 * CR-BE-FX-01 PART 03 — the governed conversion authority.
 *
 * These tests drive the REAL `fxConversionService.convert` through an injected
 * gateway, so the resolution order, the direct/inverse decision, the exact
 * decimal arithmetic and the provenance contract are all executed here without a
 * database. Nothing is stubbed inside the authority under test.
 *
 * The gateway fake applies the same predicates as the real PART 01 SQL
 * (`status = 'ACTIVE'`, `rate_type = 'REFERENCE'`, and the closed-open window),
 * so a superseded or not-yet-effective rate behaves here exactly as it does in
 * PostgreSQL.
 */

const MODULE_PATH = resolve('src/modules/fx-rates');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';

/**
 * Static assertions must inspect CODE, not prose: several PART 03 files name
 * `toFixed` and `parseFloat` inside comments precisely to say they are not used.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\/\/|\*)/, '').replace(/\s\/\/.*$/, ''))
    .join('\n');
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

type RateSeed = {
  id?: string;
  base: string;
  quote: string;
  rate: string;
  from: string;
  to?: string | null;
  status?: FxRate['status'];
  rateType?: FxRate['rateType'];
  source?: FxRate['source'];
  sourceReference?: string | null;
  ingestedAt?: Date | null;
};

function rate(seed: RateSeed, index = 0): FxRate {
  return {
    id: seed.id ?? `00000000-0000-4000-8000-0000000000${(index + 1).toString().padStart(2, '0')}`,
    baseCurrencyCode: seed.base,
    quoteCurrencyCode: seed.quote,
    rateType: seed.rateType ?? 'REFERENCE',
    rate: seed.rate,
    effectiveFrom: new Date(seed.from),
    effectiveTo: seed.to === undefined ? null : seed.to === null ? null : new Date(seed.to),
    status: seed.status ?? 'ACTIVE',
    source: seed.source ?? 'MANUAL_TREASURY',
    sourceReference: seed.sourceReference ?? null,
    ingestedAt: seed.ingestedAt ?? null,
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

type GatewayConfig = {
  rates?: RateSeed[];
  policy?: ClientFxPolicy | null;
  currencies?: Record<string, number>;
  allowed?: string[];
};

/** Records every pair queried, so "no triangulation" can be asserted for real. */
function buildGateway(config: GatewayConfig = {}): { gateway: FxRateGateway; queried: string[] } {
  const rates = (config.rates ?? []).map(rate);
  const precision = config.currencies ?? { IDR: 0, USD: 2, SGD: 2, EUR: 2, JPY: 0 };
  const allowed = config.allowed ?? ['IDR', 'USD', 'SGD', 'EUR', 'JPY'];
  const clientPolicy = config.policy === undefined ? policy() : config.policy;
  const queried: string[] = [];

  const covers = (row: FxRate, at: Date): boolean =>
    row.status === 'ACTIVE' &&
    row.rateType === 'REFERENCE' &&
    row.effectiveFrom.getTime() <= at.getTime() &&
    (row.effectiveTo === null || row.effectiveTo.getTime() > at.getTime());

  const gateway: FxRateGateway = {
    findActiveCurrency: async (code) =>
      code in precision ? { code, decimalPrecision: precision[code]! } : null,
    findClientFxPolicy: async () => clientPolicy,
    findNotAllowedCurrencies: async (_clientId, codes) => codes.filter((c) => !allowed.includes(c)),
    findActiveCovering: async (base, quote, at) => {
      queried.push(`${base}/${quote}`);
      return rates.filter((row) => row.baseCurrencyCode === base && row.quoteCurrencyCode === quote && covers(row, at));
    },
    countPairCoverage: async (base, quote, at) => {
      const forPair = rates.filter((row) => row.baseCurrencyCode === base && row.quoteCurrencyCode === quote);
      const active = forPair.filter((row) => row.status === 'ACTIVE');
      const coverage: FxPairCoverage = {
        anyStatus: forPair.length,
        active: active.length,
        activeNotYetEffective: active.filter((row) => row.effectiveFrom.getTime() > at.getTime()).length,
        activeExpired: active.filter((row) => row.effectiveTo !== null && row.effectiveTo.getTime() <= at.getTime()).length,
      };
      return coverage;
    },
  };

  return { gateway, queried };
}

function request(overrides: Partial<FxConversionRequest> = {}): FxConversionRequest {
  return {
    clientId: CLIENT_ID,
    sourceCurrencyCode: 'USD',
    targetCurrencyCode: 'IDR',
    amount: '120',
    referenceDate: '2026-03-15T00:00:00.000Z',
    purpose: 'test',
    ...overrides,
  };
}

const USD_IDR = { base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' };

describe('CR-BE-FX-01 PART 03 — identity conversion', () => {
  it('returns the amount unchanged with no rate lookup and no fabricated rate', async () => {
    const { gateway, queried } = buildGateway({ rates: [USD_IDR] });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'IDR', amount: '1234567' }),
      gateway,
    );
    assert.equal(result.conversionMode, 'IDENTITY');
    assert.equal(result.convertedAmount, '1234567', 'identity must not re-round or rescale');
    assert.equal(result.sourceAmount, '1234567');
    assert.deepEqual(queried, [], 'identity must perform NO rate lookup at all');
    assert.equal(result.provenance.fxRateId, null, 'no fake rate id');
    assert.equal(result.provenance.rate, null, 'no fake rate');
    assert.equal(result.provenance.conversionMode, 'IDENTITY');
  });

  it('does not require a Client FX policy for identity', async () => {
    const { gateway } = buildGateway({ policy: null });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'IDR' }),
      gateway,
    );
    assert.equal(result.conversionMode, 'IDENTITY');
  });
});

describe('CR-BE-FX-01 PART 03 — direct conversion (1 BASE = RATE x QUOTE)', () => {
  it('multiplies amount by rate and rounds to the target precision', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR] });
    const result = await fxConversionService.convert(request({ amount: '120' }), gateway);
    assert.equal(result.conversionMode, 'DIRECT');
    assert.equal(result.convertedAmount, '1980000', '120 x 16500 = 1 980 000 IDR (0 decimals)');
    assert.equal(result.provenance.unroundedConvertedAmount, '1980000');
    assert.equal(result.provenance.rateBaseCurrencyCode, 'USD');
    assert.equal(result.provenance.rateQuoteCurrencyCode, 'IDR');
  });

  it('applies the target currency decimal_precision from the Currency Master', async () => {
    // IDR target -> 0 decimals
    const toIdr = await fxConversionService.convert(
      request({ amount: '10.555' }),
      buildGateway({ rates: [{ base: 'USD', quote: 'IDR', rate: '3', from: '2026-01-01T00:00:00.000Z' }] }).gateway,
    );
    assert.equal(toIdr.convertedAmount, '32', '31.665 rounds half-up to 32 at 0 decimals');
    assert.equal(toIdr.provenance.targetDecimalPrecision, 0);

    // EUR target -> 2 decimals
    const toEur = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'EUR', amount: '10.555' }),
      buildGateway({
        rates: [{ base: 'IDR', quote: 'EUR', rate: '3', from: '2026-01-01T00:00:00.000Z' }],
        policy: policy({ reportingCurrencyCode: 'EUR' }),
      }).gateway,
    );
    assert.equal(toEur.convertedAmount, '31.67', '31.665 rounds half-up to 31.67 at 2 decimals');
    assert.equal(toEur.provenance.targetDecimalPrecision, 2);
  });

  it('never uses JavaScript float arithmetic', async () => {
    // 0.1 x 3 is 0.30000000000000004 as a float but exactly 0.3 in decimals.
    const { gateway } = buildGateway({
      rates: [{ base: 'USD', quote: 'EUR', rate: '3', from: '2026-01-01T00:00:00.000Z' }],
      policy: policy({ reportingCurrencyCode: 'EUR' }),
    });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'USD', targetCurrencyCode: 'EUR', amount: '0.1' }),
      gateway,
    );
    assert.equal(result.provenance.unroundedConvertedAmount, '0.3');
    assert.equal(result.convertedAmount, '0.30');
    assert.notEqual(0.1 * 3, 0.3, 'sanity: the float path really does drift');
  });

  it('prefers DIRECT over INVERSE when both resolve', async () => {
    const { gateway, queried } = buildGateway({
      rates: [
        USD_IDR,
        { base: 'IDR', quote: 'USD', rate: '0.00006', from: '2026-01-01T00:00:00.000Z' },
      ],
      policy: policy({ inversePermitted: true }),
    });
    const result = await fxConversionService.convert(request(), gateway);
    assert.equal(result.conversionMode, 'DIRECT');
    assert.equal(result.convertedAmount, '1980000');
    assert.deepEqual(queried, ['USD/IDR'], 'the reverse pair must not even be queried once DIRECT resolves');
  });
});

describe('CR-BE-FX-01 PART 03 — inverse conversion', () => {
  // Stored pair USD(base)/IDR(quote) at 16500, i.e. 1 USD = 16 500 IDR.
  const USD_IDR_ONLY = { base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' };
  // The Client reports in USD, so IDR -> USD is the governed direction and must
  // be reached by inverting the stored USD/IDR rate.
  const usdPolicy = { inversePermitted: true, reportingCurrencyCode: 'USD' };

  it('divides by the stored direct rate and records INVERSE', async () => {
    const { gateway } = buildGateway({
      rates: [USD_IDR_ONLY],
      policy: policy(usdPolicy),
      currencies: { IDR: 0, USD: 2 },
    });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '1980000' }),
      gateway,
    );
    assert.equal(result.conversionMode, 'INVERSE');
    assert.equal(result.convertedAmount, '120.00', '1 980 000 / 16 500 = 120.00 USD at 2 decimals');
    // Provenance keeps the STORED pair and the stored rate, never a reciprocal.
    assert.equal(result.provenance.fxRateId !== null, true);
    assert.equal(result.provenance.rate, '16500', 'the stored published rate is retained, not a reciprocal');
    assert.equal(result.provenance.rateBaseCurrencyCode, 'USD');
    assert.equal(result.provenance.rateQuoteCurrencyCode, 'IDR');
    assert.equal(result.provenance.unroundedConvertedAmount, null, 'no unrounded quotient is claimed');
  });

  it('rounds a non-terminating quotient exactly once, half-up, at the target scale', async () => {
    const { gateway } = buildGateway({
      rates: [USD_IDR_ONLY],
      policy: policy(usdPolicy),
      currencies: { IDR: 0, USD: 2 },
    });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '16500' }),
      gateway,
    );
    assert.equal(result.convertedAmount, '1.00');
    const third = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '1' }),
      gateway,
    );
    assert.equal(third.convertedAmount, '0.00', '1 / 16500 = 0.0000606... rounds to 0.00 at 2 decimals');
  });

  it('fails closed when inversePermitted is false', async () => {
    const { gateway } = buildGateway({
      rates: [USD_IDR_ONLY],
      policy: policy({ inversePermitted: false, reportingCurrencyCode: 'USD' }),
    });
    await assert.rejects(
      fxConversionService.convert(
        request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '1980000' }),
        gateway,
      ),
      (error: unknown) => codeOf(error) === 'FX_INVERSE_NOT_PERMITTED',
    );
  });

  it('reports the missing direct pair, not INVERSE_NOT_PERMITTED, when no reverse pair exists either', async () => {
    const { gateway } = buildGateway({ rates: [], policy: policy({ inversePermitted: false }) });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'FX_PAIR_NOT_GOVERNED',
    );
  });
});

describe('CR-BE-FX-01 PART 03 — effective window is closed-open and never widened', () => {
  const WINDOWED = {
    base: 'USD', quote: 'IDR', rate: '16500',
    from: '2026-01-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z',
  };

  it('selects a rate at the inclusive start of its window', async () => {
    const { gateway } = buildGateway({ rates: [WINDOWED] });
    const result = await fxConversionService.convert(
      request({ referenceDate: '2026-01-01T00:00:00.000Z' }),
      gateway,
    );
    assert.equal(result.conversionMode, 'DIRECT');
  });

  it('selects a rate just before the exclusive end', async () => {
    const { gateway } = buildGateway({ rates: [WINDOWED] });
    const result = await fxConversionService.convert(
      request({ referenceDate: '2026-06-30T23:59:59.999Z' }),
      gateway,
    );
    assert.equal(result.conversionMode, 'DIRECT');
  });

  it('rejects the exact exclusive end rather than falling back', async () => {
    const { gateway } = buildGateway({ rates: [WINDOWED] });
    await assert.rejects(
      fxConversionService.convert(request({ referenceDate: '2026-07-01T00:00:00.000Z' }), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_NOT_EFFECTIVE',
      '[from, to) excludes the end; no nearest/latest rate is substituted',
    );
  });

  it('never selects a superseded rate', async () => {
    const { gateway } = buildGateway({
      rates: [
        { ...WINDOWED, id: '00000000-0000-4000-8000-0000000000aa', status: 'SUPERSEDED' },
      ],
    });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_INACTIVE',
      'rows exist for the pair but none is ACTIVE',
    );
  });

  it('never selects a future rate early', async () => {
    const { gateway } = buildGateway({
      rates: [{ base: 'USD', quote: 'IDR', rate: '16500', from: '2026-06-01T00:00:00.000Z' }],
    });
    await assert.rejects(
      fxConversionService.convert(request({ referenceDate: '2026-03-15T00:00:00.000Z' }), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_FUTURE_ONLY',
    );
  });

  it('never selects a rate that is still pending approval', async () => {
    const { gateway } = buildGateway({
      rates: [{ ...WINDOWED, status: 'PENDING_APPROVAL' }],
    });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_INACTIVE',
    );
  });
});

describe('CR-BE-FX-01 PART 03 — Client policy fail-closed', () => {
  it('fails when no policy exists', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR], policy: null });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'FX_CLIENT_POLICY_NOT_FOUND',
    );
  });

  it('fails when the policy is disabled', async () => {
    const { gateway } = buildGateway({
      rates: [USD_IDR],
      policy: policy({ fxEnabled: false }),
    });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'FX_NOT_ENABLED_FOR_CLIENT',
    );
  });

  it('fails when the target is not the governed reporting currency', async () => {
    const { gateway } = buildGateway({
      rates: [{ base: 'USD', quote: 'SGD', rate: '1.35', from: '2026-01-01T00:00:00.000Z' }],
      policy: policy({ reportingCurrencyCode: 'IDR' }),
    });
    await assert.rejects(
      fxConversionService.convert(request({ targetCurrencyCode: 'SGD' }), gateway),
      (error: unknown) => codeOf(error) === 'FX_TARGET_NOT_GOVERNED',
    );
  });

  it('fails when the source or target is not an allowed Client transaction currency', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR], allowed: ['IDR'] });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'CLIENT_CURRENCY_NOT_ALLOWED',
    );
  });

  it('fails when the resolved rate source is not permitted', async () => {
    const { gateway } = buildGateway({
      rates: [{ ...USD_IDR, source: 'MANUAL_TREASURY' }],
      policy: policy({ permittedSources: [] }),
    });
    await assert.rejects(
      fxConversionService.convert(request(), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_SOURCE_NOT_PERMITTED',
    );
  });

  it('fails closed on an UNKNOWN currency instead of assuming IDR or 1:1', async () => {
    const { gateway, queried } = buildGateway({ rates: [USD_IDR] });
    for (const sourceCurrencyCode of [null, undefined, '']) {
      await assert.rejects(
        fxConversionService.convert(request({ sourceCurrencyCode }), gateway),
        (error: unknown) => codeOf(error) === 'FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE',
        `source ${JSON.stringify(sourceCurrencyCode)} must not be converted`,
      );
    }
    assert.deepEqual(queried, [], 'an UNKNOWN currency must not trigger any rate lookup');
  });

  it('fails on a currency that is not ACTIVE in the master', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR], currencies: { IDR: 0, USD: 2 } });
    await assert.rejects(
      fxConversionService.convert(request({ sourceCurrencyCode: 'SGD' }), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_CURRENCY_INACTIVE_OR_UNKNOWN',
    );
  });
});

describe('CR-BE-FX-01 PART 03 — staleness is evaluated centrally', () => {
  it('accepts a rate within the bound and rejects one beyond it', async () => {
    const rates = [{ base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' }];

    const within = await fxConversionService.convert(
      request({ referenceDate: '2026-01-20T00:00:00.000Z' }),
      buildGateway({ rates, policy: policy({ maxStalenessDays: 30 }) }).gateway,
    );
    assert.equal(within.conversionMode, 'DIRECT', '19 days is within a 30-day bound');

    await assert.rejects(
      fxConversionService.convert(
        request({ referenceDate: '2026-03-15T00:00:00.000Z' }),
        buildGateway({ rates, policy: policy({ maxStalenessDays: 30 }) }).gateway,
      ),
      (error: unknown) => codeOf(error) === 'FX_RATE_STALE',
      '73 days exceeds a 30-day bound',
    );
  });

  it('treats the exact bound as not stale ("exceeds" is strict)', async () => {
    const rates = [{ base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' }];
    const exact = await fxConversionService.convert(
      request({ referenceDate: '2026-01-31T00:00:00.000Z' }),
      buildGateway({ rates, policy: policy({ maxStalenessDays: 30 }) }).gateway,
    );
    assert.equal(exact.conversionMode, 'DIRECT', 'exactly 30 days does not exceed a 30-day bound');

    await assert.rejects(
      fxConversionService.convert(
        request({ referenceDate: '2026-01-31T00:00:00.001Z' }),
        buildGateway({ rates, policy: policy({ maxStalenessDays: 30 }) }).gateway,
      ),
      (error: unknown) => codeOf(error) === 'FX_RATE_STALE',
      'one millisecond past 30 days exceeds the bound',
    );
  });

  it('applies no staleness bound when maxStalenessDays is null', async () => {
    const rates = [{ base: 'USD', quote: 'IDR', rate: '16500', from: '2020-01-01T00:00:00.000Z' }];
    const result = await fxConversionService.convert(
      request({ referenceDate: '2026-03-15T00:00:00.000Z' }),
      buildGateway({ rates, policy: policy({ maxStalenessDays: null }) }).gateway,
    );
    assert.equal(result.conversionMode, 'DIRECT');
  });
});

describe('CR-BE-FX-01 PART 03 — ambiguity and input validation', () => {
  it('fails closed when more than one ACTIVE rate covers the instant', async () => {
    const { gateway } = buildGateway({
      rates: [
        { base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' },
        { base: 'USD', quote: 'IDR', rate: '16600', from: '2026-02-01T00:00:00.000Z' },
      ],
    });
    await assert.rejects(
      fxConversionService.convert(request({ referenceDate: '2026-03-15T00:00:00.000Z' }), gateway),
      (error: unknown) => codeOf(error) === 'FX_RATE_AMBIGUOUS',
    );
  });

  it('rejects an invalid amount', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR] });
    for (const amount of ['0', '-100', 'abc', '1e5', '', Number.NaN]) {
      await assert.rejects(
        fxConversionService.convert(request({ amount }), gateway),
        (error: unknown) => codeOf(error) === 'FX_CONVERSION_AMOUNT_INVALID',
        `amount ${JSON.stringify(amount)} must be rejected`,
      );
    }
  });

  it('rejects an invalid or missing referenceDate and never substitutes now()', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR] });
    for (const referenceDate of ['not-a-date', '', undefined as unknown as string]) {
      await assert.rejects(
        fxConversionService.convert(request({ referenceDate }), gateway),
        (error: unknown) => codeOf(error) === 'FX_REFERENCE_DATE_INVALID',
        `referenceDate ${JSON.stringify(referenceDate)} must be rejected`,
      );
    }
  });
});

describe('CR-BE-FX-01 PART 03 — no triangulation', () => {
  it('resolves at most one authoritative rate row and never routes via a third currency', async () => {
    // USD -> EUR is absent; a USD/IDR and an IDR/EUR rate both exist, so a
    // triangulating implementation would be able to reach EUR through IDR.
    const { gateway, queried } = buildGateway({
      rates: [
        { base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' },
        { base: 'IDR', quote: 'EUR', rate: '0.00006', from: '2026-01-01T00:00:00.000Z' },
        { base: 'USD', quote: 'EUR', rate: '0', from: '2030-01-01T00:00:00.000Z' },
      ],
      policy: policy({ reportingCurrencyCode: 'EUR', inversePermitted: true }),
    });
    await assert.rejects(
      fxConversionService.convert(request({ sourceCurrencyCode: 'USD', targetCurrencyCode: 'EUR' }), gateway),
      (error: unknown) =>
        ['FX_PAIR_NOT_GOVERNED', 'FX_RATE_NOT_EFFECTIVE', 'FX_RATE_FUTURE_ONLY'].includes(codeOf(error)),
      'the only USD/EUR row starts in 2030, so the correct outcome is FUTURE_ONLY — never a route via IDR',
    );
    assert.deepEqual(
      [...new Set(queried)].sort(),
      ['EUR/USD', 'USD/EUR'],
      'only the direct pair and its exact reverse may be queried — never IDR as an intermediate',
    );
  });

  it('statically contains no intermediate-leg logic', () => {
    const source = readFileSync(resolve(MODULE_PATH, 'fx-conversion.service.ts'), 'utf8');
    assert.doesNotMatch(source, /baseCurrencyCode[^)]*reportingCurrencyCode/i);
    const lookups = source.match(/gateway\.findActiveCovering\(/g) ?? [];
    assert.equal(lookups.length, 2, 'exactly two lookups: the direct pair and its reverse');
  });
});

describe('CR-BE-FX-01 PART 03 — provenance contract', () => {
  it('carries every required field for DIRECT', async () => {
    const { gateway } = buildGateway({
      rates: [{
        ...USD_IDR,
        id: '00000000-0000-4000-8000-0000000000ab',
        sourceReference: 'TREASURY-2026-01-01',
        ingestedAt: new Date('2026-01-01T06:00:00.000Z'),
      }],
    });
    const result = await fxConversionService.convert(request({ amount: '120' }), gateway);
    const p = result.provenance;
    assert.equal(result.sourceAmount, '120');
    assert.equal(result.sourceCurrencyCode, 'USD');
    assert.equal(result.targetCurrencyCode, 'IDR');
    assert.equal(result.convertedAmount, '1980000');
    assert.equal(result.referenceDate, '2026-03-15T00:00:00.000Z');
    assert.equal(result.conversionMode, 'DIRECT');
    assert.equal(p.conversionMode, 'DIRECT');
    assert.equal(p.fxRateId, '00000000-0000-4000-8000-0000000000ab');
    assert.equal(p.rate, '16500');
    assert.equal(p.rateType, 'REFERENCE');
    assert.equal(p.rateSource, 'MANUAL_TREASURY');
    assert.equal(p.rateSourceReference, 'TREASURY-2026-01-01');
    assert.equal(p.rateEffectiveFrom?.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(p.rateEffectiveTo, null);
    assert.equal(p.rateIngestedAt?.toISOString(), '2026-01-01T06:00:00.000Z');
    assert.equal(p.roundingMode, FX_ROUNDING_MODE);
    assert.equal(FX_ROUNDING_MODE, 'HALF_UP', 'the rounding mode is the one frozen by governance §3');
    assert.ok(typeof result.convertedAt === 'string' && !Number.isNaN(Date.parse(result.convertedAt)));
    assert.equal(result.purpose, 'test');
  });

  it('carries the stored pair for INVERSE so a reader can see the reversal', async () => {
    const { gateway } = buildGateway({
      // Stored as USD(base)/IDR(quote); the Client reports in USD, so the
      // governed IDR -> USD conversion must invert this stored rate.
      rates: [{ base: 'USD', quote: 'IDR', rate: '16500', from: '2026-01-01T00:00:00.000Z' }],
      policy: policy({ inversePermitted: true, reportingCurrencyCode: 'USD' }),
    });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'USD', amount: '1980000' }),
      gateway,
    );
    assert.equal(result.provenance.conversionMode, 'INVERSE');
    assert.equal(result.provenance.rateBaseCurrencyCode, 'USD');
    assert.equal(result.provenance.rateQuoteCurrencyCode, 'IDR');
    assert.equal(result.provenance.rate, '16500');
    assert.equal(result.convertedAmount, '120.00');
  });

  it('never fabricates a rate for IDENTITY', async () => {
    const { gateway } = buildGateway({ rates: [USD_IDR] });
    const result = await fxConversionService.convert(
      request({ sourceCurrencyCode: 'IDR', targetCurrencyCode: 'IDR' }),
      gateway,
    );
    assert.equal(result.provenance.fxRateId, null);
    assert.equal(result.provenance.rate, null);
    assert.equal(result.provenance.rateSource, null);
    assert.equal(result.provenance.rateEffectiveFrom, null);
  });
});

describe('CR-BE-FX-01 PART 03 — transient only, no persistence, no new migration', () => {
  const partThreeFiles = ['fx-conversion.service.ts', 'fx-conversion.gateway.ts', 'fx-decimal.ts'];

  it('writes nothing: no INSERT, UPDATE or DELETE anywhere in the conversion authority', () => {
    for (const file of partThreeFiles) {
      const body = readFileSync(resolve(MODULE_PATH, file), 'utf8');
      assert.doesNotMatch(body, /\bINSERT\s+INTO\b/i, `${file} must not insert`);
      assert.doesNotMatch(body, /\bUPDATE\s+[a-z_]+\s+SET\b/i, `${file} must not update`);
      assert.doesNotMatch(body, /\bDELETE\s+FROM\b/i, `${file} must not delete`);
    }
  });

  it('emits no audit event: a read conversion is not a lifecycle event', () => {
    for (const file of partThreeFiles) {
      const body = readFileSync(resolve(MODULE_PATH, file), 'utf8');
      assert.doesNotMatch(body, /recordOperationalEvent|fxRateEventRepository/, `${file} must not audit`);
    }
  });

  it('does not touch any monetary transaction table', () => {
    const body = readFileSync(resolve(MODULE_PATH, 'fx-conversion.gateway.ts'), 'utf8');
    for (const table of [
      'vendor_service_costs', 'basic_expenses', 'tenant_charges', 'tenant_invoices',
      'vendor_invoices', 'purchase_orders', 'price_catalog_entries', 'operational_budgets',
      'operational_commitments', 'utility_bills',
    ]) {
      assert.ok(!body.includes(table), `the conversion authority must not reference ${table}`);
    }
  });

  it('creates no conversion ledger and consumes no 0334', () => {
    const migrations = resolve('src/database/migrations');
    assert.equal(existsSync(resolve(migrations, '0334_create_fx_conversion_ledger.ts')), false);
    const highest = readdirSync(migrations).filter((f) => /^\d{4}_/.test(f)).sort().at(-1);
    assert.equal(highest, '0333_create_fx_rate_authority_and_client_fx_policy.ts');
    for (const file of partThreeFiles) {
      assert.doesNotMatch(readFileSync(resolve(MODULE_PATH, file), 'utf8'), /fx_conversions\b/);
    }
  });

  it('exposes no HTTP conversion endpoint', () => {
    const routes = readFileSync(resolve(MODULE_PATH, 'fx-rate.routes.ts'), 'utf8');
    assert.doesNotMatch(routes, /convert|quote|fx-conversion/i);
    const registry = readFileSync(resolve('src/routes/index.ts'), 'utf8');
    assert.doesNotMatch(registry, /fx-conversion/i, 'the conversion authority is internal only');
  });
});

describe('CR-BE-FX-01 PART 03 — the arithmetic authority is singular', () => {
  it('keeps both operations inside one function, applyRate', () => {
    const source = readFileSync(resolve(MODULE_PATH, 'fx-conversion.service.ts'), 'utf8');
    assert.match(source, /function applyRate\(/);
    const applyRateBody = source.slice(
      source.indexOf('function applyRate('),
      source.indexOf('export const fxConversionService'),
    );
    // DIRECT multiplies and INVERSE divides, both inside applyRate and nowhere else.
    assert.equal(applyRateBody.split('multiply(').length - 1, 1);
    assert.equal(applyRateBody.split('divideHalfUp(').length - 1, 1);
    const outsideApplyRate = source.replace(applyRateBody, '');
    assert.doesNotMatch(outsideApplyRate, /multiply\(/, 'no monetary multiplication outside applyRate');
    // divideHalfUp also appears in the staleness message, which renders a
    // DURATION in days — not a monetary value — so it is the only other caller.
    const durationOnly = outsideApplyRate.replace(/import[\s\S]*?from '\.\/fx-decimal';/, '');
    assert.equal(
      durationOnly.split('divideHalfUp(').length - 1,
      1,
      'the only non-monetary divideHalfUp call is the staleness day count',
    );
  });

  it('never rounds through toFixed/parseFloat/Number arithmetic', () => {
    for (const file of ['fx-conversion.service.ts', 'fx-decimal.ts']) {
      const body = stripComments(readFileSync(resolve(MODULE_PATH, file), 'utf8'));
      assert.doesNotMatch(body, /toFixed\(/, `${file} must not use toFixed`);
      assert.doesNotMatch(body, /parseFloat\(/, `${file} must not use parseFloat`);
      assert.doesNotMatch(body, /Math\.round\(/, `${file} must not use Math.round for money`);
    }
  });

  it('documents the frozen canonical convention', () => {
    const source = readFileSync(resolve(MODULE_PATH, 'fx-conversion.service.ts'), 'utf8');
    assert.match(source, /1 BASE = RATE x QUOTE/);
    assert.match(source, /DIRECT\s*: source = BASE,\s*target = QUOTE\s*->\s*amount x rate/);
    assert.match(source, /INVERSE : source = QUOTE, target = BASE\s*->\s*amount \/ rate/);
  });
});

describe('CR-BE-FX-01 PART 03 — nothing outside the authority duplicates it (§1)', () => {
  const SRC = resolve('src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const all = walk(SRC).map((file) => ({ file, body: stripComments(readFileSync(file, 'utf8')) }));
  const outside = all.filter(({ file }) => !file.startsWith(`${MODULE_PATH}${sep}`));

  it('found the rest of the source tree to scan', () => {
    assert.ok(outside.length > 500, `expected a large source tree, scanned ${outside.length}`);
  });

  it('performs no FX rate arithmetic anywhere else in src/', () => {
    const offenders = outside.filter(({ body }) =>
      /amount\s*[*/]\s*rate/i.test(body) ||
      /\*\s*fxRate\b/i.test(body) ||
      /\bfxRate\.[a-z]*rate\b\s*[*/]/i.test(body),
    );
    assert.deepEqual(offenders.map((o) => o.file), [], 'FX arithmetic must live only in fx-conversion.service.ts');
  });

  it('reads the fx_rates table from nowhere else', () => {
    // The migration that CREATES the table is DDL, not a consumer, so the
    // migrations directory is excluded from this check.
    const offenders = outside.filter(
      ({ file, body }) => !file.includes(`${sep}migrations${sep}`) && /\bfx_rates\b/.test(body),
    );
    assert.deepEqual(offenders.map((o) => o.file), [], 'only the FX module may read fx_rates');
  });

  it('has exactly one sanctioned consumer: the PART 04 reporting layer', () => {
    // PART 03 shipped with no consumer; PART 04 introduced the single reporting
    // integration. Anything else consuming the authority directly is a second
    // FX integration and must be rejected here.
    // Scanned across ALL of src: the sanctioned consumer lives inside fx-rates,
    // so the fx-rates exclusion used by the other checks does not apply here.
    const consumers = all
      .filter(({ file, body }) => !file.endsWith(`${sep}fx-conversion.service.ts`) &&
        !file.endsWith(`${sep}fx-conversion.gateway.ts`) &&
        !file.endsWith(`${sep}index.ts`) &&
        /fx-conversion\.service|fxConversionService/.test(body))
      .map((o) => o.file.replace(`${resolve('src')}${sep}`, ''));
    assert.deepEqual(
      consumers.sort(),
      ['modules/fx-rates/fx-reporting.service.ts'],
      'only the PART 04 reporting layer may consume the conversion authority',
    );
  });

  it('keeps the decimal primitives private to the FX module', () => {
    const offenders = outside.filter(({ body }) => /fx-decimal/.test(body));
    assert.deepEqual(offenders.map((o) => o.file), [], 'fx-decimal must not be imported outside fx-rates');
  });
});

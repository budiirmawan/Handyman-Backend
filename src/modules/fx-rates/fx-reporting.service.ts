import {
  add,
  parseDecimal,
  toDecimalString,
  type Decimal,
} from './fx-decimal';
import { fxConversionService, type FxConversionProvenance, type FxRateGateway } from './fx-conversion.service';

/**
 * CR-BE-FX-01 PART 04 — reporting-currency view over original-currency facts.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §10 (Reporting currency),
 * §8 (provenance), §12 (missing rate), and PART 04 §3, §5, §6, §7, §8, §9, §10, §11.
 *
 * WHAT THIS IS. A read-side layer that sits BESIDE the authoritative
 * original-currency facts and adds a converted view. It never replaces,
 * rewrites or re-denominates a source amount, and it never mutates a business
 * record.
 *
 * WHAT THIS IS NOT. It is not a second FX engine. Every conversion goes through
 * `fxConversionService.convert` — rate lookup, direct/inverse selection,
 * staleness, rounding, Currency Master precision and provenance construction all
 * stay in PART 03. This module contains no rate lookup, no multiplication or
 * division by a rate, and no rounding rule of its own. The only arithmetic here
 * is exact addition of SAME-CURRENCY amounts, which is ordinary aggregation.
 *
 * FAIL SAFE. Anything that cannot be converted is reported explicitly in
 * `unconvertible` with a machine-readable reason and the underlying PART 03
 * error code. Failed records are never hidden, and a partial total is never
 * presented as a grand total: `convertedTotal` is either COMPLETE or `null`.
 */

/** Machine-readable reasons a monetary fact could not be converted (§8). */
export const FX_UNCONVERTIBLE_REASONS = [
  'UNKNOWN_SOURCE_CURRENCY',
  'BUSINESS_DATE_MISSING',
  'FX_POLICY_UNAVAILABLE',
  'FX_DISABLED',
  'RATE_MISSING',
  'RATE_STALE',
  'RATE_AMBIGUOUS',
  'CURRENCY_NOT_ALLOWED',
  'REPORTING_TARGET_MISMATCH',
] as const;

export type FxUnconvertibleReason = (typeof FX_UNCONVERTIBLE_REASONS)[number];

/**
 * One monetary fact to be considered for conversion.
 *
 * The caller must supply the source amount, the source currency snapshot and
 * the record's OWN business date. A missing currency or a missing business date
 * is never guessed.
 */
export type FxReportingMonetaryFact = {
  sourceType: string;
  sourceId: string;
  amount: string | number;
  /** The transaction currency snapshot. null/empty means UNKNOWN. */
  currencyCode: string | null | undefined;
  /** The record's own business date. null means not convertible. */
  businessDate: Date | string | null | undefined;
};

export type FxUnconvertibleDetail = {
  sourceType: string;
  sourceId: string;
  amount: string;
  currencyCode: string | null;
  businessDate: string | null;
  reason: FxUnconvertibleReason;
  /** The underlying PART 03 code, preserved so nothing is hidden (§8). */
  errorCode: string | null;
  message: string | null;
};

/** The untouched original-currency groups. `currencyCode: null` is the UNKNOWN group. */
export type FxOriginalCurrencyTotal = {
  currencyCode: string | null;
  amount: string;
  count: number;
};

export type FxConvertedComponent = {
  sourceType: string;
  sourceId: string;
  sourceAmount: string;
  sourceCurrencyCode: string;
  convertedAmount: string;
  targetCurrencyCode: string;
  referenceDate: string;
  conversionMode: 'DIRECT' | 'INVERSE' | 'IDENTITY';
  /** Full PART 03 provenance, per component. Never collapsed to a report-level rate. */
  provenance: FxConversionProvenance;
};

/**
 * A converted grand total is returned ONLY when every required component
 * converted successfully. There is deliberately no partial subtotal: governance
 * §9 permits one only if already frozen, and it is not.
 */
export type FxConvertedTotal = {
  amount: string;
  currencyCode: string;
  completeness: 'COMPLETE';
};

export type FxReportingCurrencyView = {
  clientId: string;
  /** null when no governed reporting currency could be resolved. */
  reportingCurrencyCode: string | null;
  /** Authoritative, untouched: the original-currency groups. */
  originalCurrencyTotals: FxOriginalCurrencyTotal[];
  /** COMPLETE total, or null. Never a partial total presented as complete. */
  convertedTotal: FxConvertedTotal | null;
  convertedComponents: FxConvertedComponent[];
  unconvertible: FxUnconvertibleDetail[];
};

/** Maps a PART 03 fail-closed code onto the §8 reporting reason vocabulary. */
const REASON_BY_ERROR_CODE: Readonly<Record<string, FxUnconvertibleReason>> = {
  FX_CLIENT_POLICY_NOT_FOUND: 'FX_POLICY_UNAVAILABLE',
  FX_NOT_ENABLED_FOR_CLIENT: 'FX_DISABLED',
  FX_TARGET_NOT_GOVERNED: 'REPORTING_TARGET_MISMATCH',
  CLIENT_CURRENCY_NOT_ALLOWED: 'CURRENCY_NOT_ALLOWED',
  FX_RATE_AMBIGUOUS: 'RATE_AMBIGUOUS',
  FX_RATE_STALE: 'RATE_STALE',
  FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE: 'UNKNOWN_SOURCE_CURRENCY',
  // Every remaining "no usable rate" condition collapses to RATE_MISSING, with
  // the precise PART 03 code preserved alongside it.
  FX_PAIR_NOT_GOVERNED: 'RATE_MISSING',
  FX_RATE_NOT_EFFECTIVE: 'RATE_MISSING',
  FX_RATE_INACTIVE: 'RATE_MISSING',
  FX_RATE_FUTURE_ONLY: 'RATE_MISSING',
  FX_RATE_SOURCE_NOT_PERMITTED: 'RATE_MISSING',
  FX_INVERSE_NOT_PERMITTED: 'RATE_MISSING',
  FX_RATE_CURRENCY_INACTIVE_OR_UNKNOWN: 'RATE_MISSING',
};

function errorCodeOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function errorMessageOf(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function reasonFor(errorCode: string | null): FxUnconvertibleReason {
  if (errorCode !== null && errorCode in REASON_BY_ERROR_CODE) {
    return REASON_BY_ERROR_CODE[errorCode]!;
  }
  // Unknown conditions still fail safe: reported, never silently dropped.
  return 'RATE_MISSING';
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function amountStringOf(value: string | number): string {
  try {
    return toDecimalString(parseDecimal(value));
  } catch {
    return String(value);
  }
}

export const fxReportingService = {
  /**
   * Builds the reporting-currency view for a set of monetary facts.
   *
   * Ordering is fixed and fail-safe:
   *   1. resolve the governed reporting currency from the Client FX Policy —
   *      never from a hardcoded currency, a Building, a document type, a UI
   *      preference or arbitrary request input;
   *   2. group the ORIGINAL amounts by their own currency snapshot (UNKNOWN
   *      stays its own group) — this view is always returned, converted or not;
   *   3. convert each fact independently through the PART 03 authority, at that
   *      fact's OWN business date;
   *   4. return a COMPLETE total only if every fact converted.
   */
  async buildReportingCurrencyView(input: {
    clientId: string;
    facts: readonly FxReportingMonetaryFact[];
    /**
     * The PART 03 data boundary; the production binding is `databaseFxRateGateway`.
     *
     * The Client FX Policy is read through this SAME gateway that the conversion
     * authority uses, so there is exactly one policy source. A separate policy
     * reader would let the reporting layer and PART 03 disagree about whether FX
     * is enabled.
     */
    gateway: FxRateGateway;
  }): Promise<FxReportingCurrencyView> {
    const { clientId, facts, gateway } = input;

    // ---- 1. Governed reporting currency --------------------------------
    const policy = await gateway.findClientFxPolicy(clientId);
    const reportingCurrencyCode =
      policy !== null && policy.fxEnabled ? policy.reportingCurrencyCode : null;

    // ---- 2. Original-currency groups, always authoritative --------------
    // Exact same-currency addition. No rate is involved, so this is ordinary
    // aggregation and not FX arithmetic.
    const groups = new Map<string, { currencyCode: string | null; total: Decimal; count: number }>();
    for (const fact of facts) {
      const code =
        fact.currencyCode === null || fact.currencyCode === undefined || String(fact.currencyCode).trim() === ''
          ? null
          : String(fact.currencyCode).trim().toUpperCase();
      const key = code ?? '\u0000UNKNOWN';
      const amount = parseDecimal(fact.amount);
      const existing = groups.get(key);
      if (existing) {
        existing.total = add(existing.total, amount);
        existing.count += 1;
      } else {
        groups.set(key, { currencyCode: code, total: amount, count: 1 });
      }
    }
    const originalCurrencyTotals: FxOriginalCurrencyTotal[] = [...groups.values()]
      .map((group) => ({
        currencyCode: group.currencyCode,
        amount: toDecimalString(group.total),
        count: group.count,
      }))
      // UNKNOWN sorts last so the readable currencies lead.
      .sort((a, b) =>
        a.currencyCode === null ? 1 : b.currencyCode === null ? -1 : a.currencyCode.localeCompare(b.currencyCode),
      );

    const detailFor = (
      fact: FxReportingMonetaryFact,
      reason: FxUnconvertibleReason,
      errorCode: string | null,
      message: string | null,
    ): FxUnconvertibleDetail => ({
      sourceType: fact.sourceType,
      sourceId: fact.sourceId,
      amount: amountStringOf(fact.amount),
      currencyCode:
        fact.currencyCode === null || fact.currencyCode === undefined || String(fact.currencyCode).trim() === ''
          ? null
          : String(fact.currencyCode).trim().toUpperCase(),
      businessDate: isoOf(fact.businessDate),
      reason,
      errorCode,
      message,
    });

    // ---- Policy-level failure: every fact is unconvertible, nothing hidden --
    if (policy === null || !policy.fxEnabled) {
      const reason: FxUnconvertibleReason = policy === null ? 'FX_POLICY_UNAVAILABLE' : 'FX_DISABLED';
      const code = policy === null ? 'FX_CLIENT_POLICY_NOT_FOUND' : 'FX_NOT_ENABLED_FOR_CLIENT';
      return {
        clientId,
        reportingCurrencyCode: null,
        originalCurrencyTotals,
        convertedTotal: null,
        convertedComponents: [],
        unconvertible: facts.map((fact) => detailFor(fact, reason, code, null)),
      };
    }

    // ---- 3. Convert each fact independently at its OWN business date -----
    // Past the fail-closed policy guard, the reporting currency is governed
    // and non-null (ClientFxPolicy.reportingCurrencyCode is `string`); bind
    // it once so the conversion authority and the COMPLETE total share it.
    const targetCurrencyCode: string = policy.reportingCurrencyCode;
    const convertedComponents: FxConvertedComponent[] = [];
    const unconvertible: FxUnconvertibleDetail[] = [];
    let convertedTotalDecimal: Decimal | null = null;

    for (const fact of facts) {
      const currencyCode =
        fact.currencyCode === null || fact.currencyCode === undefined || String(fact.currencyCode).trim() === ''
          ? null
          : String(fact.currencyCode).trim().toUpperCase();

      // UNKNOWN currency stays UNKNOWN: never IDR, never the base, never identity.
      if (currencyCode === null) {
        unconvertible.push(
          detailFor(fact, 'UNKNOWN_SOURCE_CURRENCY', 'FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE', null),
        );
        continue;
      }

      // A source without a defensible business date is NOT converted and no date
      // is invented. Report generation time, created_at and "now" are never used.
      if (fact.businessDate === null || fact.businessDate === undefined) {
        unconvertible.push(detailFor(fact, 'BUSINESS_DATE_MISSING', null, null));
        continue;
      }
      const referenceDate = fact.businessDate instanceof Date ? fact.businessDate : new Date(fact.businessDate);
      if (Number.isNaN(referenceDate.getTime())) {
        unconvertible.push(detailFor(fact, 'BUSINESS_DATE_MISSING', null, 'referenceDate is not a valid date'));
        continue;
      }

      try {
        // The single conversion authority. Identity components go through it too,
        // so provenance and semantics stay consistent and no local arithmetic
        // bypasses it.
        const result = await fxConversionService.convert(
          {
            clientId,
            sourceCurrencyCode: currencyCode,
            targetCurrencyCode,
            amount: fact.amount,
            referenceDate,
            purpose: `${fact.sourceType}:${fact.sourceId}`,
          },
          gateway,
        );
        convertedComponents.push({
          sourceType: fact.sourceType,
          sourceId: fact.sourceId,
          sourceAmount: result.sourceAmount,
          sourceCurrencyCode: result.sourceCurrencyCode,
          convertedAmount: result.convertedAmount,
          targetCurrencyCode: result.targetCurrencyCode,
          referenceDate: result.referenceDate,
          conversionMode: result.conversionMode,
          provenance: result.provenance,
        });
        const converted = parseDecimal(result.convertedAmount);
        convertedTotalDecimal = convertedTotalDecimal === null ? converted : add(convertedTotalDecimal, converted);
      } catch (error) {
        const code = errorCodeOf(error);
        unconvertible.push(detailFor(fact, reasonFor(code), code, errorMessageOf(error)));
      }
    }

    // ---- 4. Completeness: all or nothing ---------------------------------
    const convertedTotal: FxConvertedTotal | null =
      unconvertible.length === 0 && convertedTotalDecimal !== null
        ? {
            amount: toDecimalString(convertedTotalDecimal),
            currencyCode: targetCurrencyCode,
            completeness: 'COMPLETE',
          }
        : null;

    return {
      clientId,
      reportingCurrencyCode,
      originalCurrencyTotals,
      convertedTotal,
      convertedComponents,
      unconvertible,
    };
  },
};

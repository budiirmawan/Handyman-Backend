import { AppError } from '../../shared/errors';
import {
  clientCurrencyNotAllowedError,
  fxClientPolicyNotFoundError,
  fxConversionAmountInvalidError,
  fxInverseNotPermittedError,
  fxNotEnabledForClientError,
  fxPairNotGovernedError,
  fxRateAmbiguousError,
  fxRateCurrencyInactiveOrUnknownError,
  fxRateFutureOnlyError,
  fxRateInactiveError,
  fxRateNotEffectiveError,
  fxRateSourceNotPermittedError,
  fxRateStaleError,
  fxReferenceDateInvalidError,
  fxTargetNotGovernedError,
  fxUnknownCurrencyNotConvertibleError,
} from './fx-rate.errors';
import {
  divideHalfUp,
  multiply,
  parseDecimal,
  roundHalfUp,
  toDecimalString,
  type Decimal,
} from './fx-decimal';
import type { ClientFxPolicy, FxRate, FxRateSource, FxRateType } from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 03 — THE governed FX conversion authority.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §3, §6, §7, §8, §11, §12.
 *
 * This is the ONLY place in the repository where an amount is multiplied or
 * divided by an FX rate. Both operations live in `applyRate` below (§7 rule 1).
 * Rate lookup, the direct/inverse decision, staleness, rounding and provenance
 * construction are all centralised here so no later module can reimplement a
 * variant of any of them.
 *
 * CANONICAL CONVENTION (frozen, §3): 1 BASE = RATE x QUOTE.
 *   DIRECT  : source = BASE,  target = QUOTE  ->  amount x rate
 *   INVERSE : source = QUOTE, target = BASE   ->  amount / rate
 * The stored rate is always the published direct rate; a reciprocal is never
 * persisted (§11 rule 2).
 *
 * TRANSIENT ONLY. This service reads and returns. It never writes a converted
 * amount, never creates a ledger row, never emits an operational event and never
 * emits an `fx_rate_event` — a read conversion is not a lifecycle event (§13).
 *
 * NO TRIANGULATION. One conversion resolves at most ONE authoritative rate row.
 * A -> B -> C, routing via the Client base, via IDR, or via the reporting
 * currency as an intermediate, is not implemented and cannot be expressed here.
 *
 * ARITHMETIC. Exact decimal (`fx-decimal.ts`), never a JavaScript float, and
 * never `toFixed`/`parseFloat` as a rounding mechanism (§7 rule 3). Rounding is
 * HALF_UP, applied once, at the target currency's `decimal_precision` (§3).
 */

/** Milliseconds in a day. Used only for the staleness comparison, in decimals. */
const MS_PER_DAY = '86400000';

/** Rounding mode frozen by governance §3. Recorded in every provenance block. */
export const FX_ROUNDING_MODE = 'HALF_UP' as const;

export type FxConversionMode = 'DIRECT' | 'INVERSE' | 'IDENTITY';

export type FxConversionRequest = {
  clientId: string;
  /**
   * The transaction currency snapshot of the amount being converted. It must be
   * supplied explicitly. It is NEVER derived from the Client base currency, the
   * Client default transaction currency, a Building, a document type, or an IDR
   * assumption. `null`/UNKNOWN is never converted.
   */
  sourceCurrencyCode: string | null | undefined;
  targetCurrencyCode: string | null | undefined;
  amount: string | number;
  /**
   * The monetary record's own business date. `created_at` and "now" are never
   * substituted, so a historical report is reproducible (§6).
   */
  referenceDate: Date | string;
  /** Free-text caller intent, echoed into provenance. */
  purpose?: string | null;
  actorUserId?: string | null;
};

export type FxConversionProvenance = {
  conversionMode: FxConversionMode;
  /** Null for IDENTITY. Never fabricated. */
  fxRateId: string | null;
  /** The stored rate, copied as stored. Null for IDENTITY. */
  rate: string | null;
  rateType: FxRateType | null;
  rateSource: FxRateSource | null;
  rateSourceReference: string | null;
  rateEffectiveFrom: Date | null;
  rateEffectiveTo: Date | null;
  rateIngestedAt: Date | null;
  /** The pair AS STORED, so an INVERSE result shows the stored pair is reversed. */
  rateBaseCurrencyCode: string | null;
  rateQuoteCurrencyCode: string | null;
  /** Target currency scale taken from the Currency Master. */
  targetDecimalPrecision: number;
  roundingMode: typeof FX_ROUNDING_MODE;
  /**
   * The exact pre-rounding product, present for DIRECT (where `amount x rate`
   * is finitely representable). Null for INVERSE and IDENTITY: an exact quotient
   * need not be finitely representable, and the half-up decision is made from
   * the exact remainder instead.
   */
  unroundedConvertedAmount: string | null;
};

export type FxConversionResult = {
  sourceAmount: string;
  sourceCurrencyCode: string;
  targetCurrencyCode: string;
  convertedAmount: string;
  referenceDate: string;
  conversionMode: FxConversionMode;
  convertedAt: string;
  purpose: string | null;
  provenance: FxConversionProvenance;
};

export type FxPairCoverage = {
  anyStatus: number;
  active: number;
  activeNotYetEffective: number;
  activeExpired: number;
};

/**
 * The data boundary this authority reads through.
 *
 * Injected rather than imported so this module stays free of any database
 * dependency: the resolution order, the direct/inverse decision, the arithmetic
 * and the provenance contract are all exercisable in isolation. The production
 * binding lives in `fx-conversion.gateway.ts`. This does not create a second
 * conversion authority — the policy and the arithmetic still live only here.
 */
export type FxRateGateway = {
  findActiveCurrency(code: string): Promise<{ code: string; decimalPrecision: number } | null>;
  findClientFxPolicy(clientId: string): Promise<ClientFxPolicy | null>;
  findNotAllowedCurrencies(clientId: string, codes: string[]): Promise<string[]>;
  findActiveCovering(base: string, quote: string, at: Date): Promise<FxRate[]>;
  countPairCoverage(base: string, quote: string, at: Date): Promise<FxPairCoverage>;
};

const CURRENCY_CODE = /^[A-Z]{3}$/;

function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CURRENCY_CODE.test(code) ? code : null;
}

/**
 * Validates source permission and staleness for a resolved rate. Shared by
 * DIRECT and INVERSE so the staleness rule is implemented exactly once and no
 * later module can reinterpret it.
 */
function assertRateUsable(
  rate: FxRate,
  policy: ClientFxPolicy,
  referenceDate: Date,
  clientId: string,
): void {
  if (!policy.permittedSources.includes(rate.source)) {
    throw fxRateSourceNotPermittedError(rate.source, clientId);
  }
  if (policy.maxStalenessDays !== null) {
    // Governance §6 step 7: fail when `referenceDate - effective_from` EXCEEDS
    // the bound. Compared exactly in integer milliseconds — NOT after rounding
    // to a day count, which would let a sub-day excess slip through.
    const elapsedMs = BigInt(Math.max(0, referenceDate.getTime() - rate.effectiveFrom.getTime()));
    const boundMs = BigInt(policy.maxStalenessDays) * BigInt(MS_PER_DAY);
    if (elapsedMs > boundMs) {
      // The day figure is for the message only; the decision above is exact.
      const days = divideHalfUp(parseDecimal(elapsedMs.toString()), parseDecimal(MS_PER_DAY), 4);
      throw fxRateStaleError(rate.id, policy.maxStalenessDays, toDecimalString(days));
    }
  }
}

function identityProvenance(precision: number): FxConversionProvenance {
  return {
    conversionMode: 'IDENTITY',
    fxRateId: null,
    rate: null,
    rateType: null,
    rateSource: null,
    rateSourceReference: null,
    rateEffectiveFrom: null,
    rateEffectiveTo: null,
    rateIngestedAt: null,
    rateBaseCurrencyCode: null,
    rateQuoteCurrencyCode: null,
    targetDecimalPrecision: precision,
    roundingMode: FX_ROUNDING_MODE,
    unroundedConvertedAmount: null,
  };
}

function rateProvenance(
  mode: Exclude<FxConversionMode, 'IDENTITY'>,
  rate: FxRate,
  precision: number,
  unrounded: string | null,
): FxConversionProvenance {
  return {
    conversionMode: mode,
    fxRateId: rate.id,
    // Copied as stored. A later supersession cannot change this value.
    rate: rate.rate,
    rateType: rate.rateType,
    rateSource: rate.source,
    rateSourceReference: rate.sourceReference,
    rateEffectiveFrom: rate.effectiveFrom,
    rateEffectiveTo: rate.effectiveTo,
    rateIngestedAt: rate.ingestedAt,
    rateBaseCurrencyCode: rate.baseCurrencyCode,
    rateQuoteCurrencyCode: rate.quoteCurrencyCode,
    targetDecimalPrecision: precision,
    roundingMode: FX_ROUNDING_MODE,
    unroundedConvertedAmount: unrounded,
  };
}

/**
 * THE single arithmetic authority (§7 rule 1).
 *
 * DIRECT multiplies, INVERSE divides. No other function in the repository
 * performs either operation on an FX rate.
 */
function applyRate(
  mode: 'DIRECT' | 'INVERSE',
  amount: Decimal,
  rate: Decimal,
  targetPrecision: number,
): { converted: Decimal; unrounded: string | null } {
  if (mode === 'DIRECT') {
    const exact = multiply(amount, rate);
    return { converted: roundHalfUp(exact, targetPrecision), unrounded: toDecimalString(exact) };
  }
  // The exact quotient is not always finitely representable, so the half-up
  // decision is taken from the exact remainder inside divideHalfUp and no
  // "unrounded" figure is claimed.
  return { converted: divideHalfUp(amount, rate, targetPrecision), unrounded: null };
}

/**
 * Chooses the precise fail-closed reason when no rate resolves for an ordered
 * pair, so a caller is told *why* rather than receiving a generic absence (§12).
 */
function missingRateError(
  source: string,
  target: string,
  coverage: FxPairCoverage,
  referenceDate: string,
): AppError {
  if (coverage.anyStatus === 0) return fxPairNotGovernedError(source, target);
  if (coverage.active === 0) return fxRateInactiveError(source, target);
  if (coverage.activeNotYetEffective > 0 && coverage.activeExpired === 0) {
    return fxRateFutureOnlyError(source, target, referenceDate);
  }
  return fxRateNotEffectiveError(source, target, referenceDate);
}

export const fxConversionService = {
  /**
   * Converts one amount. Returns complete inline provenance, or throws one of
   * the §12 fail-closed codes. Never returns a converted amount alongside an
   * error, and never fabricates a rate.
   */
  async convert(
    request: FxConversionRequest,
    gateway: FxRateGateway,
  ): Promise<FxConversionResult> {
    // ---- 1. Inputs ------------------------------------------------------
    if (typeof request.clientId !== 'string' || request.clientId.trim().length === 0) {
      throw AppError.badRequest('clientId is required for an FX conversion.');
    }
    const clientId = request.clientId.trim();

    let amount: Decimal;
    try {
      amount = parseDecimal(request.amount);
    } catch {
      throw fxConversionAmountInvalidError(`'${String(request.amount)}' is not a plain decimal literal.`);
    }
    if (amount.unscaled <= 0n) {
      throw fxConversionAmountInvalidError('amount must be strictly greater than zero.');
    }

    const referenceDate =
      request.referenceDate instanceof Date
        ? request.referenceDate
        : new Date(request.referenceDate ?? '');
    if (Number.isNaN(referenceDate.getTime())) {
      throw fxReferenceDateInvalidError(`'${String(request.referenceDate)}' is not a valid date.`);
    }

    // ---- 2. UNKNOWN currency is never converted (§12) -------------------
    if (
      request.sourceCurrencyCode === null ||
      request.sourceCurrencyCode === undefined ||
      String(request.sourceCurrencyCode).trim() === '' ||
      request.targetCurrencyCode === null ||
      request.targetCurrencyCode === undefined ||
      String(request.targetCurrencyCode).trim() === ''
    ) {
      throw fxUnknownCurrencyNotConvertibleError();
    }

    const source = normalizeCurrencyCode(request.sourceCurrencyCode);
    const target = normalizeCurrencyCode(request.targetCurrencyCode);
    if (source === null || target === null) {
      throw fxRateCurrencyInactiveOrUnknownError(
        String(source === null ? request.sourceCurrencyCode : request.targetCurrencyCode),
      );
    }

    // ---- 3. IDENTITY: no policy, no rate, no lookup (§6 step 1) ---------
    if (source === target) {
      const targetCurrency = await gateway.findActiveCurrency(target);
      if (!targetCurrency) throw fxRateCurrencyInactiveOrUnknownError(target);
      return {
        sourceAmount: toDecimalString(amount),
        sourceCurrencyCode: source,
        targetCurrencyCode: target,
        // The amount is returned unchanged. FX invents no rounding for the
        // identity case; monetary-scale normalisation belongs to the owner.
        convertedAmount: toDecimalString(amount),
        referenceDate: referenceDate.toISOString(),
        conversionMode: 'IDENTITY',
        convertedAt: new Date().toISOString(),
        purpose: request.purpose ?? null,
        provenance: identityProvenance(targetCurrency.decimalPrecision),
      };
    }

    // ---- 4. Currency legs must be ACTIVE in the master ------------------
    const [sourceCurrency, targetCurrency] = await Promise.all([
      gateway.findActiveCurrency(source),
      gateway.findActiveCurrency(target),
    ]);
    if (!sourceCurrency) throw fxRateCurrencyInactiveOrUnknownError(source);
    if (!targetCurrency) throw fxRateCurrencyInactiveOrUnknownError(target);
    const targetPrecision = targetCurrency.decimalPrecision;

    // ---- 5. Client policy: fail closed (§6 steps 3-4) -------------------
    const policy = await gateway.findClientFxPolicy(clientId);
    if (!policy) throw fxClientPolicyNotFoundError(clientId);
    if (!policy.fxEnabled) throw fxNotEnabledForClientError(clientId);

    // ---- 6. Client currency allowance (CUR-01 authority) ----------------
    const notAllowed = await gateway.findNotAllowedCurrencies(clientId, [source, target]);
    if (notAllowed.length > 0) throw clientCurrencyNotAllowedError(notAllowed[0]!, clientId);

    // ---- 7. Governed reporting target (§6 step 4) -----------------------
    if (target !== policy.reportingCurrencyCode) {
      throw fxTargetNotGovernedError(target, policy.reportingCurrencyCode);
    }

    const amountDecimal = parseDecimal(toDecimalString(amount));
    const referenceIso = referenceDate.toISOString();

    // ---- 8. DIRECT resolution (§6 step 5) -------------------------------
    const direct = await gateway.findActiveCovering(source, target, referenceDate);
    if (direct.length > 1) throw fxRateAmbiguousError(source, target, direct.length);

    if (direct.length === 1) {
      const rate = direct[0]!;
      assertRateUsable(rate, policy, referenceDate, clientId);
      const { converted, unrounded } = applyRate(
        'DIRECT',
        amountDecimal,
        parseDecimal(rate.rate),
        targetPrecision,
      );
      return {
        sourceAmount: toDecimalString(amountDecimal),
        sourceCurrencyCode: source,
        targetCurrencyCode: target,
        convertedAmount: toDecimalString(converted),
        referenceDate: referenceIso,
        conversionMode: 'DIRECT',
        convertedAt: new Date().toISOString(),
        purpose: request.purpose ?? null,
        provenance: rateProvenance('DIRECT', rate, targetPrecision, unrounded),
      };
    }

    // ---- 9. INVERSE resolution (§6 step 5, §11) -------------------------
    // The stored pair is (base = target, quote = source): source = QUOTE,
    // target = BASE, so converted = amount / rate.
    const reverse = await gateway.findActiveCovering(target, source, referenceDate);
    if (reverse.length > 1) throw fxRateAmbiguousError(target, source, reverse.length);

    if (reverse.length === 1) {
      const rate = reverse[0]!;
      // A reverse pair exists but inverse is not permitted -> fail closed
      // (§11 rule 1). The rate is never silently inverted.
      if (!policy.inversePermitted) throw fxInverseNotPermittedError(source, target, clientId);
      assertRateUsable(rate, policy, referenceDate, clientId);
      const { converted } = applyRate(
        'INVERSE',
        amountDecimal,
        parseDecimal(rate.rate),
        targetPrecision,
      );
      return {
        sourceAmount: toDecimalString(amountDecimal),
        sourceCurrencyCode: source,
        targetCurrencyCode: target,
        convertedAmount: toDecimalString(converted),
        referenceDate: referenceIso,
        conversionMode: 'INVERSE',
        convertedAt: new Date().toISOString(),
        purpose: request.purpose ?? null,
        provenance: rateProvenance('INVERSE', rate, targetPrecision, null),
      };
    }

    // ---- 10. Nothing resolved: report exactly why (§12) -----------------
    // NO triangulation: the Client base, IDR and the reporting currency are
    // never tried as an intermediate leg.
    const coverage = await gateway.countPairCoverage(source, target, referenceDate);
    throw missingRateError(source, target, coverage, referenceIso);
  },
};

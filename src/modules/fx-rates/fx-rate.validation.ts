import { AppError } from '../../shared/errors';
import {
  fxPolicyReportingCurrencyInvalidError,
  fxPolicySourceUnsupportedError,
  fxPolicyStalenessInvalidError,
  fxRateCurrencyInactiveOrUnknownError,
  fxRateInvalidRateError,
  fxRatePairIdenticalError,
  fxRateSourceUnsupportedError,
  fxRateTypeUnsupportedError,
  fxRateWindowInvalidError,
} from './fx-rate.errors';
import {
  FX_RATE_MAX_DECIMALS,
  FX_RATE_MAX_INTEGER_DIGITS,
  isFxRateSource,
  isFxRateType,
  type FxRateSource,
  type FxRateType,
  type NewFxRate,
  type UpsertClientFxPolicyInput,
} from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 01 — FX Rate Authority validation (pure, no database).
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §3, §4, §6.
 *
 * These guards are the application-side mirror of the `0333` CHECK constraints.
 * They exist so a governed 4xx is returned instead of a raw Postgres violation;
 * the database constraints remain the authority and are what actually make the
 * invariants un-bypassable.
 *
 * Deliberately free of any arithmetic on monetary values: PART 01 does not
 * convert anything.
 */

/** Currency codes are the Currency Master's uppercase three-letter identity. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * A plain decimal literal. Exponent notation (`1e5`), thousands separators,
 * `NaN`/`Infinity` and hex are all rejected: a rate is stored and transmitted
 * as an exact decimal, never as a JS float rendering.
 */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

export function isCurrencyCodeFormat(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE.test(value);
}

/**
 * Exact, float-free decimal inspection of a rate literal.
 *
 * Returns the digit counts and whether the value is strictly positive, without
 * ever passing the value through `Number`.
 */
export function inspectRateLiteral(raw: string): {
  integerDigits: number;
  decimalDigits: number;
  isPositive: boolean;
  isZero: boolean;
  canonical: string;
} {
  const trimmed = raw.trim();
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [rawInteger = '', rawFraction = ''] = unsigned.split('.');

  // Leading zeros do not consume NUMERIC(24,12) integer capacity.
  const integerWithoutLeadingZeros = rawInteger.replace(/^0+/, '');
  const integerDigits = integerWithoutLeadingZeros.length;
  const decimalDigits = rawFraction.length;

  const isZero = integerWithoutLeadingZeros.length === 0 && !/[1-9]/.test(rawFraction);
  const canonical = `${sign < 0 ? '-' : ''}${integerWithoutLeadingZeros || '0'}${
    rawFraction.length > 0 ? `.${rawFraction}` : ''
  }`;

  return { integerDigits, decimalDigits, isPositive: sign > 0 && !isZero, isZero, canonical };
}

/**
 * Validates a submitted rate against the frozen NUMERIC(24,12) shape and the
 * `rate > 0` invariant (§3, §4).
 *
 * Accepts a string or a number, but validates the DECIMAL LITERAL that will be
 * bound to Postgres — so a float can never smuggle exponent notation or a
 * representation the database would round differently.
 */
export function validateRateLiteral(rate: string | number): string {
  const literal = typeof rate === 'number' ? String(rate) : String(rate ?? '').trim();

  if (literal.length === 0 || !DECIMAL_LITERAL.test(literal)) {
    throw fxRateInvalidRateError(
      `'${literal}' is not a plain decimal literal (exponent notation, separators and non-finite values are not accepted).`,
    );
  }

  const { integerDigits, decimalDigits, isPositive, isZero, canonical } = inspectRateLiteral(literal);

  if (isZero) {
    throw fxRateInvalidRateError('rate must be strictly greater than zero; a zero rate is never valid.');
  }
  if (!isPositive) {
    throw fxRateInvalidRateError('rate must be strictly greater than zero; negative rates are not valid.');
  }
  if (integerDigits > FX_RATE_MAX_INTEGER_DIGITS) {
    throw fxRateInvalidRateError(
      `rate has ${integerDigits} integer digits; NUMERIC(24,12) allows at most ${FX_RATE_MAX_INTEGER_DIGITS}.`,
    );
  }
  if (decimalDigits > FX_RATE_MAX_DECIMALS) {
    throw fxRateInvalidRateError(
      `rate has ${decimalDigits} decimal places; NUMERIC(24,12) allows at most ${FX_RATE_MAX_DECIMALS}.`,
    );
  }

  return canonical;
}

/** `base <> quote` — the frozen model never stores a 1:1 identity rate (§4, §6). */
export function assertDistinctCurrencyPair(baseCurrencyCode: string, quoteCurrencyCode: string): void {
  if (baseCurrencyCode === quoteCurrencyCode) {
    throw fxRatePairIdenticalError(baseCurrencyCode);
  }
}

export function validateRateType(value: unknown): FxRateType {
  if (!isFxRateType(value)) {
    throw fxRateTypeUnsupportedError(String(value));
  }
  return value;
}

export function validateRateSource(value: unknown): FxRateSource {
  if (!isFxRateSource(value)) {
    throw fxRateSourceUnsupportedError(String(value));
  }
  return value;
}

/**
 * Effective windows are CLOSED-OPEN `[effective_from, effective_to)`.
 * `effectiveTo === null` means the window is still open, which is valid.
 * A future `effectiveFrom` is legitimate scheduling and is NOT rejected here.
 */
export function validateEffectiveWindow(
  effectiveFrom: Date | string,
  effectiveTo: Date | string | null | undefined,
): { effectiveFrom: Date; effectiveTo: Date | null } {
  const from = toDate(effectiveFrom, 'effectiveFrom');
  if (effectiveTo === null || effectiveTo === undefined || effectiveTo === '') {
    return { effectiveFrom: from, effectiveTo: null };
  }
  const to = toDate(effectiveTo, 'effectiveTo');
  if (!(to.getTime() > from.getTime())) {
    throw fxRateWindowInvalidError();
  }
  return { effectiveFrom: from, effectiveTo: to };
}

/** Normalizes a proposed rate into the exact shape `0333` will persist. */
export function validateNewFxRate(input: NewFxRate): {
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  rate: string;
  rateType: FxRateType;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: FxRateSource;
  sourceReference: string | null;
} {
  const base = validateCurrencyCodeFormat(input.baseCurrencyCode, fxRateCurrencyInactiveOrUnknownError);
  const quote = validateCurrencyCodeFormat(input.quoteCurrencyCode, fxRateCurrencyInactiveOrUnknownError);
  assertDistinctCurrencyPair(base, quote);

  const window = validateEffectiveWindow(input.effectiveFrom, input.effectiveTo);

  return {
    baseCurrencyCode: base,
    quoteCurrencyCode: quote,
    rate: validateRateLiteral(input.rate),
    rateType: validateRateType('REFERENCE'),
    effectiveFrom: window.effectiveFrom,
    effectiveTo: window.effectiveTo,
    source: validateRateSource(input.source),
    sourceReference: normalizeSourceReference(input.sourceReference),
  };
}

/**
 * Validates a Client FX policy payload (§6). Currency liveness, Client
 * allowance and the base-currency equality are enforced by the deferred
 * `client_fx_policy_valid` trigger, which is the authority; this guard covers
 * the shape that must fail before a round trip.
 */
export function validateClientFxPolicyInput(input: UpsertClientFxPolicyInput): {
  clientId: string;
  fxEnabled: boolean;
  reportingCurrencyCode: string;
  permittedSources: FxRateSource[];
  inversePermitted: boolean;
  maxStalenessDays: number | null;
} {
  if (typeof input.clientId !== 'string' || input.clientId.trim().length === 0) {
    throw AppError.badRequest('clientId is required to set a Client FX policy.');
  }

  const reportingCurrencyCode = validateCurrencyCodeFormat(
    input.reportingCurrencyCode,
    () => fxPolicyReportingCurrencyInvalidError(String(input.reportingCurrencyCode)),
  );

  if (!Array.isArray(input.permittedSources)) {
    throw fxPolicySourceUnsupportedError(String(input.permittedSources));
  }
  const permittedSources: FxRateSource[] = [];
  for (const candidate of input.permittedSources) {
    if (!isFxRateSource(candidate)) throw fxPolicySourceUnsupportedError(String(candidate));
    if (!permittedSources.includes(candidate)) permittedSources.push(candidate);
  }

  if (
    input.maxStalenessDays !== null &&
    input.maxStalenessDays !== undefined &&
    (!Number.isInteger(input.maxStalenessDays) || input.maxStalenessDays <= 0)
  ) {
    throw fxPolicyStalenessInvalidError();
  }

  return {
    clientId: input.clientId.trim(),
    fxEnabled: input.fxEnabled === true,
    reportingCurrencyCode,
    permittedSources,
    inversePermitted: input.inversePermitted === true,
    maxStalenessDays: input.maxStalenessDays ?? null,
  };
}

/**
 * A currency code must be the Currency Master's uppercase three-letter identity.
 * Liveness (ACTIVE) is the master's business and is checked at command time by
 * PART 02 plus the `0333` foreign key; this guard rejects a malformed code
 * before a round trip.
 */
function validateCurrencyCodeFormat(
  value: unknown,
  onError: (value: string) => Error,
): string {
  if (!isCurrencyCodeFormat(value)) throw onError(String(value));
  return value;
}

function normalizeSourceReference(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function toDate(value: Date | string, _field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw fxRateWindowInvalidError();
  }
  return date;
}

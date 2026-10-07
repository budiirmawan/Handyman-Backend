/**
 * CR-BE-FX-01 PART 03 — deterministic decimal arithmetic for FX conversion.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §3 (Precision), §7 rule 3,
 * §11 rule 4.
 *
 * WHY THIS EXISTS. The repository has no safe decimal authority: existing
 * monetary code uses `Number(value.toFixed(2))`
 * (operational-variance.service.ts:51) and `Math.round(value * 100)` float
 * tricks in validators — precisely what governance §7 rule 3 forbids for FX.
 * Governance §10 therefore requires the minimum deterministic arithmetic to be
 * implemented locally inside the FX conversion module, which is what this file
 * is. It is deliberately small: parse, multiply, divide-and-round, round, print.
 *
 * REPRESENTATION. A value is `unscaled x 10^(-scale)` held in a `BigInt`, so
 * every operation below is exact integer arithmetic. A JavaScript `Number` is
 * never used to hold or compute a monetary value, and `toFixed` / `parseFloat`
 * are never used as a rounding mechanism.
 *
 * ROUNDING. Half-up, applied once, at the target scale — the mode frozen by
 * governance §3. "Half-up" is implemented as HALF_UP in the BigDecimal sense:
 * a tie rounds away from zero. Monetary amounts and rates are strictly positive
 * in this domain, so the sign rule is a defensive detail rather than a live
 * behaviour.
 *
 * This module contains no FX policy. It does not know what a rate, a Client or
 * a currency is; `fx-conversion.service.ts` is the only caller.
 */

/** An exact decimal: `unscaled x 10^(-scale)`. */
export type Decimal = {
  readonly unscaled: bigint;
  readonly scale: number;
};

/** A plain decimal literal. Exponent notation, separators and NaN are rejected. */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

const TEN = 10n;

function pow10(exponent: number): bigint {
  if (exponent < 0) throw new Error(`Negative exponent ${exponent} has no decimal representation`);
  return TEN ** BigInt(exponent);
}

/**
 * Parses a decimal literal exactly.
 *
 * Accepts a string, or a finite number rendered through `String()` — the
 * literal that is parsed is always the caller's own decimal text, never a float
 * that has already drifted.
 */
export function parseDecimal(value: string | number): Decimal {
  const literal = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value ?? '').trim();
  if (!DECIMAL_LITERAL.test(literal)) {
    throw new Error(`'${literal}' is not a plain decimal literal`);
  }
  const negative = literal.startsWith('-');
  const unsigned = literal.replace(/^[+-]/, '');
  const [intPart = '', fracPart = ''] = unsigned.split('.');
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  const unscaled = BigInt(digits === '' ? '0' : digits);
  return { unscaled: negative ? -unscaled : unscaled, scale: fracPart.length };
}

/** True when the value is exactly zero. */
export function isZero(value: Decimal): boolean {
  return value.unscaled === 0n;
}

/** True when the value is strictly greater than zero. */
export function isPositive(value: Decimal): boolean {
  return value.unscaled > 0n;
}

/** Number of decimal places currently held. */
export function decimalScale(value: Decimal): number {
  return value.scale;
}

/** Exact multiplication. No rounding occurs here. */
export function multiply(a: Decimal, b: Decimal): Decimal {
  return { unscaled: a.unscaled * b.unscaled, scale: a.scale + b.scale };
}

/**
 * Exact addition of two decimals, aligning to the wider scale. No rounding.
 *
 * Used by the reporting layer to group SAME-CURRENCY amounts, which is ordinary
 * aggregation rather than FX arithmetic — it never involves a rate.
 */
export function add(a: Decimal, b: Decimal): Decimal {
  if (a.scale === b.scale) return { unscaled: a.unscaled + b.unscaled, scale: a.scale };
  if (a.scale < b.scale) {
    return { unscaled: a.unscaled * pow10(b.scale - a.scale) + b.unscaled, scale: b.scale };
  }
  return { unscaled: a.unscaled + b.unscaled * pow10(a.scale - b.scale), scale: a.scale };
}

/**
 * Rounds to exactly `scale` decimal places using HALF_UP (a tie rounds away
 * from zero). Returns a new value; the input is never mutated.
 *
 * If the value already fits, it is rescaled without any rounding decision, so
 * rounding an already-representable value is a no-op rather than a re-round.
 */
export function roundHalfUp(value: Decimal, scale: number): Decimal {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`Target scale must be a non-negative integer, got ${scale}`);
  }
  if (value.scale === scale) return value;

  if (value.scale < scale) {
    return { unscaled: value.unscaled * pow10(scale - value.scale), scale };
  }

  const drop = value.scale - scale;
  const factor = pow10(drop);
  const negative = value.unscaled < 0n;
  const magnitude = negative ? -value.unscaled : value.unscaled;

  const quotient = magnitude / factor;
  const remainder = magnitude % factor;
  // HALF_UP: a remainder at or above half of the dropped range rounds away from
  // zero. `factor` is a power of ten, so `factor / 2n` is exact for drop >= 1.
  const rounded = remainder * 2n >= factor ? quotient + 1n : quotient;

  return { unscaled: negative ? -rounded : rounded, scale };
}

/**
 * Exact division rounded HALF_UP to `scale` decimals.
 *
 * The rounding decision is made from the true remainder, not from a truncated
 * approximation, so the result is identical to computing the quotient to
 * unlimited precision and then rounding once. That is what governance §11 rule
 * 4 means by "exact decimal reciprocal with guard digits": no guard-digit count
 * has to be chosen, because no intermediate value is ever truncated.
 *
 * Used only for the governed INVERSE path (amount / rate).
 */
export function divideHalfUp(numerator: Decimal, denominator: Decimal, scale: number): Decimal {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`Target scale must be a non-negative integer, got ${scale}`);
  }
  if (denominator.unscaled === 0n) {
    throw new Error('Division by zero has no FX meaning');
  }

  const negative = (numerator.unscaled < 0n) !== (denominator.unscaled < 0n);
  const num = numerator.unscaled < 0n ? -numerator.unscaled : numerator.unscaled;
  const den = denominator.unscaled < 0n ? -denominator.unscaled : denominator.unscaled;

  // Align to `scale` decimals, then keep ONE extra digit so the half-up
  // decision can be made exactly.
  const shift = scale + denominator.scale - numerator.scale + 1;
  const aligned = shift >= 0 ? num * pow10(shift) : num / pow10(-shift);

  const quotient = aligned / den;
  const remainder = aligned % den;

  const lastDigit = quotient % TEN;
  const truncated = quotient / TEN;
  // Above half, or exactly half with a non-zero remainder, rounds up; exactly
  // half with no remainder is the tie, which HALF_UP also rounds up.
  const rounded = lastDigit > 5n || (lastDigit === 5n) ? truncated + 1n : truncated;
  void remainder;

  return { unscaled: negative ? -rounded : rounded, scale };
}

/** Renders an exact decimal string with no exponent notation and no float. */
export function toDecimalString(value: Decimal): string {
  const negative = value.unscaled < 0n;
  const magnitude = (negative ? -value.unscaled : value.unscaled).toString();

  if (value.scale === 0) return `${negative ? '-' : ''}${magnitude}`;

  const padded = magnitude.padStart(value.scale + 1, '0');
  const intPart = padded.slice(0, padded.length - value.scale);
  const fracPart = padded.slice(padded.length - value.scale);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

/** Convenience: parse, round HALF_UP to `scale`, and render. */
export function toFixedDecimalString(value: string | number, scale: number): string {
  return toDecimalString(roundHalfUp(parseDecimal(value), scale));
}

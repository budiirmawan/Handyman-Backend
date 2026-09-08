import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  FX_RATE_SOURCES,
  FX_RATE_STATUSES,
  FX_RATE_TYPES,
  type FxRateStatus,
} from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 01 — FX Rate Authority error factories.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §4, §6, §12.
 *
 * Every failure here is a governed 4xx via `AppError`, never an unhandled 500 —
 * the same contract CUR-02 established with `assertActiveAllowedCurrencyCommand`.
 *
 * PART 01 raises only *authority/invariant* failures. The missing-rate and
 * selection taxonomy (§12) belongs to PART 03, which is the only authority that
 * can reach those conditions.
 */

export function fxRateNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_NOT_FOUND,
    message: 'FX rate not found.',
    statusCode: 404,
    resource: { type: 'FX_RATE', id },
  });
}

export function fxRatePairIdenticalError(currencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_PAIR_IDENTICAL,
    message: `An FX rate requires two different currencies; base and quote are both ${currencyCode}. Same-currency identity is never stored as a rate.`,
    statusCode: 400,
    details: [{ field: 'quoteCurrencyCode', message: 'baseCurrencyCode and quoteCurrencyCode must differ.' }],
  });
}

/**
 * `rate` must be a finite, strictly positive decimal that fits NUMERIC(24,12).
 * The message names the precision so the caller can correct the submission.
 */
export function fxRateInvalidRateError(reason: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_INVALID_RATE,
    message: `Invalid FX rate: ${reason}`,
    statusCode: 400,
    details: [{ field: 'rate', message: 'rate must be a positive decimal within NUMERIC(24,12).' }],
  });
}

export function fxRateTypeUnsupportedError(rateType: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_TYPE_UNSUPPORTED,
    message: `FX rate type '${rateType}' is not supported. FX-01 supports only: ${FX_RATE_TYPES.join(', ')}.`,
    statusCode: 400,
    details: [
      {
        field: 'rateType',
        message: `rateType must be one of: ${FX_RATE_TYPES.join(', ')}.`,
      },
    ],
  });
}

export function fxRateSourceUnsupportedError(source: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_SOURCE_UNSUPPORTED,
    message: `FX rate source '${source}' is not supported. FX-01 supports only: ${FX_RATE_SOURCES.join(', ')}. No external provider ingestion exists.`,
    statusCode: 400,
    details: [
      {
        field: 'source',
        message: `source must be one of: ${FX_RATE_SOURCES.join(', ')}.`,
      },
    ],
  });
}

/** Effective windows are closed-open `[effective_from, effective_to)`. */
export function fxRateWindowInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_WINDOW_INVALID,
    message: 'FX rate effective window is invalid: effectiveTo must be strictly later than effectiveFrom.',
    statusCode: 400,
    details: [
      {
        field: 'effectiveTo',
        message: 'Windows are closed-open [effectiveFrom, effectiveTo); effectiveTo must be > effectiveFrom or null.',
      },
    ],
  });
}

/**
 * Both currency legs must be ACTIVE in the existing Currency Master. FX never
 * duplicates the master and never invents a currency.
 */
export function fxRateCurrencyInactiveOrUnknownError(currencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_CURRENCY_INACTIVE_OR_UNKNOWN,
    message: `Currency '${currencyCode}' is not an ACTIVE Currency Master code, so it cannot be an FX rate leg.`,
    statusCode: 400,
    details: [
      {
        field: 'currencyCode',
        message: 'baseCurrencyCode and quoteCurrencyCode must both be ACTIVE in the Currency Master.',
      },
    ],
  });
}

/**
 * Raised when two ACTIVE rates would cover the same instant for the same
 * (base, quote, rate_type). The `fx_rates_active_window_exclusion` GiST
 * constraint makes this structurally impossible; this error exists so the
 * condition is reported as a governed 409 rather than surfacing as a raw
 * Postgres exclusion violation.
 */
export function fxRateEffectiveWindowOverlapError(baseCurrencyCode: string, quoteCurrencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_EFFECTIVE_WINDOW_OVERLAP,
    message: `An ACTIVE FX rate already covers part of this effective window for ${baseCurrencyCode}/${quoteCurrencyCode}. Ambiguous rates are not permitted; close the existing window or supersede it.`,
    statusCode: 409,
    details: [
      {
        field: 'effectiveFrom',
        message: 'At most one ACTIVE rate may cover any instant for a (base, quote, rateType).',
      },
    ],
  });
}

/** Corrections happen by supersession, never by rewriting a stored rate. */
export function fxRateImmutableError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_IMMUTABLE,
    message: `FX rate field '${field}' is immutable. Correct a rate by supersession, not by rewriting it.`,
    statusCode: 409,
    details: [
      {
        field,
        message: 'FX rate business fields are immutable once written.',
      },
    ],
  });
}

export function fxRateInvalidStatusTransitionError(from: FxRateStatus, to: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_INVALID_STATUS_TRANSITION,
    message: `Invalid FX rate status transition ${from} -> ${to}. Known statuses: ${FX_RATE_STATUSES.join(', ')}.`,
    statusCode: 409,
    details: [
      {
        field: 'status',
        message: 'Frozen lifecycle: PENDING_APPROVAL -> ACTIVE|REJECTED; ACTIVE -> SUPERSEDED|INACTIVE; REJECTED/SUPERSEDED/INACTIVE are terminal.',
      },
    ],
  });
}

export function fxRateEventTypeUnsupportedError(eventType: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_EVENT_TYPE_UNSUPPORTED,
    message: `FX rate event type '${eventType}' is not supported.`,
    statusCode: 400,
    details: [{ field: 'eventType', message: 'eventType is not part of the append-only FX rate audit vocabulary.' }],
  });
}

export function fxClientPolicyNotFoundError(clientId: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_CLIENT_POLICY_NOT_FOUND,
    message: 'No FX policy exists for this client. Absence of a policy is not permission: FX fails closed.',
    statusCode: 404,
    resource: { type: 'CLIENT_FX_POLICY', id: clientId },
  });
}

export function fxPolicyReportingCurrencyInvalidError(currencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_POLICY_REPORTING_CURRENCY_INVALID,
    message: `FX reporting currency '${currencyCode}' must be an ACTIVE Currency Master code and allowed for the client.`,
    statusCode: 400,
    details: [
      {
        field: 'reportingCurrencyCode',
        message: 'reportingCurrencyCode must be ACTIVE in the Currency Master and present in the client allowed transaction currencies.',
      },
    ],
  });
}

/**
 * FX-01 does NOT add a second reporting axis: the reporting currency must equal
 * the Client base currency (§6). Decoupling them requires its own CR.
 */
export function fxPolicyReportingCurrencyNotBaseError(currencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_POLICY_REPORTING_CURRENCY_NOT_BASE,
    message: `FX reporting currency '${currencyCode}' must equal the client base currency in FX-01.`,
    statusCode: 400,
    details: [
      {
        field: 'reportingCurrencyCode',
        message: 'reportingCurrencyCode must equal client_monetary_contexts.base_currency_code.',
      },
    ],
  });
}

export function fxPolicySourceUnsupportedError(source: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_POLICY_SOURCE_UNSUPPORTED,
    message: `FX rate source '${source}' cannot be permitted. FX-01 supports only: ${FX_RATE_SOURCES.join(', ')}.`,
    statusCode: 400,
    details: [
      {
        field: 'permittedSources',
        message: `permittedSources must be a subset of: ${FX_RATE_SOURCES.join(', ')}.`,
      },
    ],
  });
}

export function fxPolicyStalenessInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.FX_POLICY_STALENESS_INVALID,
    message: 'maxStalenessDays must be a positive whole number of days, or null for no staleness bound.',
    statusCode: 400,
    details: [{ field: 'maxStalenessDays', message: 'maxStalenessDays must be > 0 or null.' }],
  });
}

// ---------------------------------------------------------------------------
// CR-BE-FX-01 PART 02 — lifecycle governance.
// ---------------------------------------------------------------------------

/**
 * Maker-checker (§15). The PART 01 `fx_rates_maker_checker_check` constraint is
 * the structural backstop; this guard produces the governed 409 first so the
 * caller gets an actionable message rather than a raw check violation.
 */
export function fxRateSelfApprovalError(rateId: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_SELF_APPROVAL,
    message: 'The maker of an FX rate cannot approve it. Approval requires a different authorized user.',
    statusCode: 409,
    resource: { type: 'FX_RATE', id: rateId },
    details: [
      {
        field: 'approvedByUserId',
        message: 'approvedByUserId must differ from createdByUserId.',
      },
    ],
  });
}

/**
 * Raised when activating or superseding a rate would place two ACTIVE rates over
 * the same instant for the same (base, quote, rate_type).
 *
 * Deliberately distinct from `fxRateEffectiveWindowOverlapError` (a proposed
 * PENDING_APPROVAL row): this is a *lifecycle* conflict, and the correct remedy
 * is to close or supersede the incumbent window first — never to silently
 * shorten it, silently supersede it, or fall back to a latest rate.
 */
export function fxRateActiveWindowConflictError(
  rateId: string,
  baseCurrencyCode: string,
  quoteCurrencyCode: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_ACTIVE_WINDOW_CONFLICT,
    message: `Activating this rate would overlap an existing ACTIVE rate for ${baseCurrencyCode}/${quoteCurrencyCode}. Close or supersede the incumbent window first; windows are never rewritten automatically.`,
    statusCode: 409,
    resource: { type: 'FX_RATE', id: rateId },
    details: [
      {
        field: 'effectiveFrom',
        message:
          'At most one ACTIVE rate may cover any instant for a (base, quote, rateType). No automatic shortening, supersession or latest-rate fallback is performed.',
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// CR-BE-FX-01 PART 03 — governed conversion / rate-selection fail-closed codes.
//
// GOVERNANCE §12. Every one of these means "no converted amount". None of them
// is ever accompanied by a fabricated figure, a 1:1 assumption, a latest-rate
// fallback or a silent inverse.
//
// Semantically identical conditions deliberately REUSE an existing code rather
// than adding a duplicate meaning:
//   policy missing          -> fxClientPolicyNotFoundError   (PART 01)
//   currency leg not ACTIVE -> fxRateCurrencyInactiveOrUnknownError (PART 01)
//   Client allowance        -> clientCurrencyNotAllowedError (below, CUR-01 code)
// ---------------------------------------------------------------------------

export function fxNotEnabledForClientError(clientId: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_NOT_ENABLED_FOR_CLIENT,
    message: 'FX is not enabled for this client. A disabled policy is never treated as permission.',
    statusCode: 422,
    resource: { type: 'CLIENT_FX_POLICY', id: clientId },
  });
}

/**
 * A NULL/UNKNOWN currency is never converted — not to IDR, not to the Client
 * base, not at 1:1. This preserves the CUR-01 §2 IDR assessment and the CUR-02
 * historical-UNKNOWN data condition.
 */
export function fxUnknownCurrencyNotConvertibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE,
    message: 'An UNKNOWN currency cannot be converted. Historical NULL currency stays UNKNOWN and is never assumed to be IDR, the client base currency, or a 1:1 rate.',
    statusCode: 422,
  });
}

export function fxTargetNotGovernedError(targetCurrencyCode: string, reportingCurrencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_TARGET_NOT_GOVERNED,
    message: `Target currency '${targetCurrencyCode}' is not the governed reporting currency '${reportingCurrencyCode}'. FX-01 converts into the reporting currency only.`,
    statusCode: 422,
    details: [{ field: 'targetCurrencyCode', message: 'targetCurrencyCode must equal the client FX policy reporting currency.' }],
  });
}

export function fxPairNotGovernedError(baseCurrencyCode: string, quoteCurrencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_PAIR_NOT_GOVERNED,
    message: `No FX rate of any status is governed for ${baseCurrencyCode}/${quoteCurrencyCode}. No rate means no converted amount.`,
    statusCode: 422,
  });
}

export function fxRateNotEffectiveError(baseCurrencyCode: string, quoteCurrencyCode: string, referenceDate: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_NOT_EFFECTIVE,
    message: `No ACTIVE FX rate for ${baseCurrencyCode}/${quoteCurrencyCode} covers ${referenceDate}. Nearest, latest and previous rates are never substituted.`,
    statusCode: 422,
  });
}

export function fxRateInactiveError(baseCurrencyCode: string, quoteCurrencyCode: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_INACTIVE,
    message: `FX rates exist for ${baseCurrencyCode}/${quoteCurrencyCode} but none is ACTIVE. An unapproved, rejected, superseded or deactivated rate is never usable.`,
    statusCode: 422,
  });
}

export function fxRateFutureOnlyError(baseCurrencyCode: string, quoteCurrencyCode: string, referenceDate: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_FUTURE_ONLY,
    message: `The only ACTIVE FX rates for ${baseCurrencyCode}/${quoteCurrencyCode} start after ${referenceDate}. A rate that has not begun cannot price the past.`,
    statusCode: 422,
  });
}

export function fxRateSourceNotPermittedError(source: string, clientId: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_SOURCE_NOT_PERMITTED,
    message: `FX rate source '${source}' is not permitted by this client's FX policy.`,
    statusCode: 422,
    resource: { type: 'CLIENT_FX_POLICY', id: clientId },
  });
}

export function fxRateStaleError(fxRateId: string, stalenessDays: number, elapsedDays: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_STALE,
    message: `The resolved FX rate is ${elapsedDays} days old at the reference date, which exceeds the client staleness bound of ${stalenessDays} days.`,
    statusCode: 422,
    resource: { type: 'FX_RATE', id: fxRateId },
  });
}

export function fxRateAmbiguousError(baseCurrencyCode: string, quoteCurrencyCode: string, count: number): AppError {
  return new AppError({
    code: ERROR_CODES.FX_RATE_AMBIGUOUS,
    message: `${count} ACTIVE FX rates cover this instant for ${baseCurrencyCode}/${quoteCurrencyCode}. Ambiguity fails closed; one is never chosen arbitrarily.`,
    statusCode: 409,
  });
}

export function fxInverseNotPermittedError(sourceCurrencyCode: string, targetCurrencyCode: string, clientId: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_INVERSE_NOT_PERMITTED,
    message: `No direct FX rate resolves for ${sourceCurrencyCode}/${targetCurrencyCode}, and this client's policy does not permit the inverse of the reverse pair. The rate is never silently inverted.`,
    statusCode: 422,
    resource: { type: 'CLIENT_FX_POLICY', id: clientId },
  });
}

/** Reuses the CUR-01 code: the meaning is exactly the existing one. */
export function clientCurrencyNotAllowedError(currencyCode: string, clientId: string): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_CURRENCY_NOT_ALLOWED,
    message: `Currency '${currencyCode}' is not an allowed transaction currency for this client, so it cannot take part in an FX conversion.`,
    statusCode: 422,
    resource: { type: 'CLIENT', id: clientId },
  });
}

export function fxConversionAmountInvalidError(reason: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_CONVERSION_AMOUNT_INVALID,
    message: `Invalid conversion amount: ${reason}`,
    statusCode: 400,
    details: [{ field: 'amount', message: 'amount must be a finite, strictly positive plain decimal.' }],
  });
}

export function fxReferenceDateInvalidError(reason: string): AppError {
  return new AppError({
    code: ERROR_CODES.FX_REFERENCE_DATE_INVALID,
    message: `Invalid referenceDate: ${reason}. The caller's business date is required; created_at and "now" are never substituted.`,
    statusCode: 400,
    details: [{ field: 'referenceDate', message: 'referenceDate must be a valid date supplied by the caller.' }],
  });
}

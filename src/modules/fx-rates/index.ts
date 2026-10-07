/**
 * CR-BE-FX-01 PART 01 — FX Rate Authority module boundary.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md.
 *
 * PART 01 is the schema and domain foundation only:
 *   - `0333_create_fx_rate_authority_and_client_fx_policy`
 *   - domain types, validation, errors, and a read/insert repository
 *
 * Explicitly NOT in this module yet:
 *   - lifecycle transition commands and maker-checker (PART 02)
 *   - the governed conversion service and rate selection policy (PART 03)
 *   - reporting-currency read models (PART 04)
 *   - HTTP routes, RBAC surfaces, OpenAPI (PART 02 / PART 06)
 *
 * No amount is ever multiplied or divided by a rate anywhere in this PART.
 */

export {
  FX_RATE_EVENT_TYPES,
  FX_RATE_INITIAL_STATUSES,
  FX_RATE_MAX_DECIMALS,
  FX_RATE_MAX_INTEGER_DIGITS,
  FX_RATE_NUMERIC_PRECISION,
  FX_RATE_NUMERIC_SCALE,
  FX_RATE_SOURCES,
  FX_RATE_STATUSES,
  FX_RATE_TERMINAL_STATUSES,
  FX_RATE_TRANSITIONS,
  FX_RATE_TYPES,
  isFxRateEventType,
  isFxRateSource,
  isFxRateStatus,
  isFxRateTerminalStatus,
  isFxRateType,
  isValidFxRateTransition,
} from './fx-rate.types';
export type {
  ClientFxPolicy,
  FxRate,
  FxRateEvent,
  FxRateEventType,
  FxRateFilters,
  FxRateInitialStatus,
  FxRateSource,
  FxRateStatus,
  FxRateTerminalStatus,
  FxRateType,
  NewFxRate,
  UpsertClientFxPolicyInput,
} from './fx-rate.types';

export {
  assertDistinctCurrencyPair,
  inspectRateLiteral,
  isCurrencyCodeFormat,
  validateClientFxPolicyInput,
  validateEffectiveWindow,
  validateNewFxRate,
  validateRateLiteral,
  validateRateSource,
  validateRateType,
} from './fx-rate.validation';

export {
  fxClientPolicyNotFoundError,
  fxPolicyReportingCurrencyInvalidError,
  fxPolicyReportingCurrencyNotBaseError,
  fxPolicySourceUnsupportedError,
  fxPolicyStalenessInvalidError,
  fxRateCurrencyInactiveOrUnknownError,
  fxRateEffectiveWindowOverlapError,
  fxRateEventTypeUnsupportedError,
  fxRateImmutableError,
  fxRateInvalidRateError,
  fxRateInvalidStatusTransitionError,
  fxRateNotFoundError,
  fxRatePairIdenticalError,
  fxRateSourceUnsupportedError,
  fxRateTypeUnsupportedError,
  fxRateWindowInvalidError,
} from './fx-rate.errors';

export {
  clientFxPolicyRepository,
  currencyMasterRepository,
  fxRateEventRepository,
  fxRateRepository,
} from './fx-rate.repository';

// --- CR-BE-FX-01 PART 02 — governed lifecycle and Client FX policy ----------
export { fxRateLifecycleService } from './fx-rate-lifecycle.service';
export type {
  CreateFxRateInput,
  FxRateLifecycleResult,
  SupersedeFxRateInput,
} from './fx-rate-lifecycle.service';

// --- CR-BE-FX-01 PART 03 — the single governed conversion authority ---------
export { FX_ROUNDING_MODE, fxConversionService } from './fx-conversion.service';
export type {
  FxConversionMode,
  FxConversionProvenance,
  FxConversionRequest,
  FxConversionResult,
  FxPairCoverage,
  FxRateGateway,
} from './fx-conversion.service';
export { databaseFxRateGateway } from './fx-conversion.gateway';

// --- CR-BE-FX-01 PART 04 — reporting-currency view over original-currency facts
export { fxReportingService, FX_UNCONVERTIBLE_REASONS } from './fx-reporting.service';
export type {
  FxConvertedComponent,
  FxConvertedTotal,
  FxOriginalCurrencyTotal,
  FxReportingCurrencyView,
  FxReportingMonetaryFact,
  FxUnconvertibleDetail,
  FxUnconvertibleReason,
} from './fx-reporting.service';
export {
  divideHalfUp,
  multiply,
  parseDecimal,
  roundHalfUp,
  toDecimalString,
} from './fx-decimal';
export type { Decimal } from './fx-decimal';

export { clientFxPolicyService } from './client-fx-policy.service';
export type {
  ClientFxPolicyReadModel,
  SetClientFxPolicyInput,
} from './client-fx-policy.service';

export { createFxRateRouter } from './fx-rate.routes';

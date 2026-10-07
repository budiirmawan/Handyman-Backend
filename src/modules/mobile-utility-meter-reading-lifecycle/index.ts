/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — mobile field reading lifecycle.
 *
 * Bounded module: src/modules/mobile-utility-meter-reading-lifecycle/
 *
 * Closes the BE-18 field-reading lifecycle with the minimum required: an explicit
 * recheck / correction model, backend-derived `availableActions`, and the offline
 * sync alignment for the same canonical write. Three field commands — request a
 * recheck, submit the reread, resolve by confirming the original OR accepting the
 * replacement — plus the two additive keys on the reading DETAIL (`rechecks`,
 * `availableActions`) that make the outcome and the caller's next legal moves
 * legible without any client-side inference.
 *
 * THE MODEL IS THE EXISTING EXCEPTION REGISTER, NOT A NEW ENGINE
 * --------------------------------------------------------------
 * A recheck is one `utility_operational_exceptions` row of type
 * `READING_RECHECK` (CR-BE-UTL-01 PART 15, extended by migration 0351 with the
 * staged-reread payload and the replacement link). Its lifecycle is the
 * register's own OPEN → UNDER_REVIEW → RESOLVED with terminal CANCELLED, its
 * transitions run through the register's own guarded service functions, and its
 * events are the register's own canonical `UTILITY_EXCEPTION_*` events. No new
 * table, no new state, no second workflow engine.
 *
 * It owns addressing (Reading Due + reading + recheck), authority (PART 02's
 * exported `authorizeFieldReading`) and bounded projection. It does NOT own
 * reading creation — an accepted reread becomes a reading through the SAME
 * canonical BE-18E `recordUtilityMeterReading` every other caller uses, in one
 * transaction with the resolve that links it — and it does not own the lifecycle
 * either.
 *
 * Out of scope by design: editing or deleting a reading (BE-18E readings stay
 * append-only and immutable), consumption recalculation, abnormality evaluation,
 * OCR, QR, BE-25H `METER_READING` (which remains BE-10C), and any billing or
 * tariff involvement.
 */

export {
  getMobileUtilityMeterReadingLifecycleDetailHandler,
  requestMobileReadingRecheckHandler,
  resolveMobileReadingRecheckHandler,
  submitMobileReadingRereadHandler,
} from './mobile-utility-meter-reading-lifecycle.controller';

export { createMobileUtilityMeterReadingLifecycleRouter } from './mobile-utility-meter-reading-lifecycle.routes';

export {
  buildMobileReadingRechecks,
  deriveMobileReadingAvailableActions,
  getMobileUtilityMeterReadingLifecycleDetail,
  mobileUtilityMeterReadingLifecycleService,
  requestMobileReadingRecheck,
  resolveMobileReadingRecheck,
  submitMobileReadingReread,
} from './mobile-utility-meter-reading-lifecycle.service';

export {
  parseMobileReadingRecheckIdParam,
  parseMobileReadingRecheckRequestBody,
  parseMobileReadingRecheckResolveBody,
} from './mobile-utility-meter-reading-lifecycle.validation';

export {
  MOBILE_READING_AVAILABLE_ACTIONS,
  MOBILE_READING_RECHECK_BODY_FIELDS,
  MOBILE_READING_RECHECK_DECISIONS,
  MOBILE_READING_RECHECK_DERIVED_FIELDS,
  MOBILE_READING_RECHECK_EXCEPTION_TYPE,
  MOBILE_READING_RECHECK_LIMIT,
  MOBILE_READING_RECHECK_OUTCOMES,
  MOBILE_READING_RECHECK_RESOLVE_BODY_FIELDS,
  MOBILE_READING_RECHECK_RESOLVE_DERIVED_FIELDS,
  MOBILE_READING_RECHECK_SEVERITY,
  MOBILE_READING_RECHECK_SUMMARY,
} from './mobile-utility-meter-reading-lifecycle.types';

export type {
  MobileReadingAvailableAction,
  MobileReadingRecheck,
  MobileReadingRecheckDecision,
  MobileReadingRecheckOutcome,
  MobileReadingRecheckRequestInput,
  MobileReadingRecheckResolution,
  MobileReadingRecheckResolveInput,
  MobileReadingReplacement,
  MobileUtilityMeterReadingLifecycleDetail,
} from './mobile-utility-meter-reading-lifecycle.types';

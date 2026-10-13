/**
 * CR-HM-15 PART 01 — Handyman SERVICE WARRANTY foundation barrel.
 * Warranty head + coverages + append-only events, with start DERIVED
 * from an ACCEPTED BAST only. No HTTP/OpenAPI, no claim intake (PART
 * 02), no rework (PART 03), no chargeable separation (PART 04), no
 * pricing/payment/settlement, no FM/SaaS coupling.
 */

export {
  HANDYMAN_SERVICE_WARRANTY_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_PART01_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES,
  HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES,
  isHandymanServiceWarrantyStatus,
  isHandymanServiceWarrantyCoverageType,
  isHandymanServiceWarrantyEventType,
} from './handyman-service-warranty.types';
export type {
  HandymanServiceWarrantyStatus,
  HandymanServiceWarrantyPart01Status,
  HandymanServiceWarrantyCoverageType,
  HandymanServiceWarrantyEventType,
  HandymanServiceWarrantyRecord,
  HandymanServiceWarrantyCoverageRecord,
  HandymanServiceWarrantyEventRecord,
  NewHandymanServiceWarranty,
  NewHandymanServiceWarrantyCoverage,
  NewHandymanServiceWarrantyEvent,
  StartHandymanServiceWarrantyInput,
  ExpireHandymanServiceWarrantyInput,
  HandymanServiceWarrantyCommandResult,
} from './handyman-service-warranty.types';

export {
  HANDYMAN_SERVICE_WARRANTY_START_SOURCES,
  HANDYMAN_NOT_SERVICE_WARRANTY_START,
  isNotServiceWarrantyStartAlias,
  evaluateHandymanServiceWarrantyEligibility,
  assertHandymanServiceWarrantyStartEligible,
  nextHandymanServiceWarrantyStatus,
  isHandymanServiceWarrantyPart01Action,
} from './handyman-service-warranty.lifecycle';
export type {
  HandymanServiceWarrantyStartSource,
  HandymanNotServiceWarrantyStart,
} from './handyman-service-warranty.lifecycle';

export {
  handymanServiceWarrantyNotFoundError,
  handymanServiceWarrantyNotEligibleError,
  handymanServiceWarrantyActiveConflictError,
  handymanServiceWarrantyIllegalTransitionError,
  handymanServiceWarrantyNotAuthorizedError,
  handymanServiceWarrantyValidationError,
} from './handyman-service-warranty.errors';

export { handymanServiceWarrantyRepository }
  from './handyman-service-warranty.repository';

export {
  startHandymanServiceWarranty,
  expireHandymanServiceWarranty,
} from './handyman-service-warranty.service';

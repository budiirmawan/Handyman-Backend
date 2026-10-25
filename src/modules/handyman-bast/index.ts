/**
 * CR-HM-11 PART 02 — Handyman BAST aggregate barrel.
 * No HTTP/OpenAPI. ACCEPT/REJECT are state-gated here.
 */

export {
  HANDYMAN_BAST_STATUSES,
  HANDYMAN_BAST_PART01_EVENT_TYPES,
  HANDYMAN_BAST_PART02_EVENT_TYPES,
  HANDYMAN_BAST_EVENT_TYPES,
  isHandymanBastStatus,
  isHandymanBastPart01EventType,
  isHandymanBastEventType,
} from './handyman-bast.types';
export type {
  HandymanBastStatus,
  HandymanBastPart01EventType,
  HandymanBastPart02EventType,
  HandymanBastEventType,
  HandymanBastRecord,
  HandymanBastEventRecord,
  HandymanBastSignOffRecord,
  NewHandymanBast,
  NewHandymanBastEvent,
  NewHandymanBastSignOff,
} from './handyman-bast.types';

export {
  handymanBastNotFoundError,
  handymanBastNotAuthorizedError,
  handymanBastScopeNotEligibleError,
  handymanBastIllegalTransitionError,
  handymanBastSignOffReservedError,
  handymanBastSignatureRequiredError,
  handymanBastActiveConflictError,
  handymanBastValidationError,
  handymanBastVersionConflictError,
  handymanBastQcNotReadyError,
} from './handyman-bast.errors';

export {
  nextHandymanBastStatus,
  assertHandymanBastSignature,
  isPart01BastAction,
} from './handyman-bast.lifecycle';

export {
  HANDYMAN_NOT_BAST_ACCEPTANCE,
  isHandymanCustomerBastAccepted,
  isHandymanWarrantyStartEligible,
  isNotBastAcceptanceAlias,
  toHandymanBastAcceptanceReadContract,
  computeBastArtifactVersion,
  toHandymanBastArtifactReference,
  resolveApprovedSignOff,
} from './handyman-bast.read-contract';
export type {
  HandymanBastAcceptanceReadContract,
  HandymanNotBastAcceptance,
  HandymanBastArtifactReference,
  HandymanBastApprovedSignOffBinding,
} from './handyman-bast.read-contract';

export { handymanBastRepository } from './handyman-bast.repository';

export {
  prepareHandymanBast,
  issueHandymanBast,
  voidHandymanBast,
  acceptHandymanBast,
  rejectHandymanBast,
  getHandymanBastCustomerCareDetail,
  getHandymanExecutionScopeBastCustomerCareView,
} from './handyman-bast.service';
export type {
  HandymanBastPrepareInput,
  HandymanBastTransitionInput,
  HandymanBastSignOffInput,
  HandymanBastCommandResult,
  HandymanBastDetailView,
  HandymanExecutionScopeBastView,
} from './handyman-bast.service';

export {
  HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL,
  HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD,
  serializeHandymanBastCustomerConsent,
  computeHandymanBastCustomerConsentDigest,
  verifiedHandymanBastCustomerConsent,
  hasVerifiedHandymanBastCustomerAcceptance,
} from './handyman-bast-customer-consent';
export type {
  HandymanBastCustomerConsentManifest, HandymanBastConsentEvidence,
} from './handyman-bast-customer-consent';

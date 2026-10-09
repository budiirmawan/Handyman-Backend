/**
 * CR-HM-15 PART 02 — Handyman SERVICE WARRANTY CLAIM INTAKE barrel.
 * Claim records bound to an EXISTING active service warranty and its
 * ORIGINAL execution scope, with state-gated SUBMIT/APPROVE/REJECT/
 * WITHDRAW and an evidence bind. No HTTP/OpenAPI, no rework execution
 * (PART 03), no chargeable separation (PART 04), no
 * pricing/payment/settlement, no FM/SaaS coupling.
 */

export {
  HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_CLAIM_EVENT_TYPES,
  HANDYMAN_SERVICE_WARRANTY_CLAIM_ACTIONS,
  isHandymanServiceWarrantyClaimStatus,
  isHandymanServiceWarrantyClaimEventType,
  isHandymanServiceWarrantyClaimAction,
} from './handyman-service-warranty-claim.types';
export type {
  HandymanServiceWarrantyClaimStatus,
  HandymanServiceWarrantyClaimEventType,
  HandymanServiceWarrantyClaimAction,
  HandymanServiceWarrantyClaimRecord,
  HandymanServiceWarrantyClaimEventRecord,
  NewHandymanServiceWarrantyClaim,
  NewHandymanServiceWarrantyClaimEvent,
  OpenHandymanServiceWarrantyClaimInput,
  SubmitHandymanServiceWarrantyClaimInput,
  DecideHandymanServiceWarrantyClaimInput,
  WithdrawHandymanServiceWarrantyClaimInput,
  HandymanServiceWarrantyClaimCommandResult,
} from './handyman-service-warranty-claim.types';

export {
  HANDYMAN_NOT_WARRANTY_CLAIM_TRIGGER,
  isNotWarrantyClaimTriggerAlias,
  assertHandymanServiceWarrantyClaimIntakeEligible,
  nextHandymanServiceWarrantyClaimStatus,
  nextHandymanServiceWarrantyClaimHeadStatus,
} from './handyman-service-warranty-claim.lifecycle';
export type {
  HandymanNotWarrantyClaimTrigger,
} from './handyman-service-warranty-claim.lifecycle';

export {
  handymanServiceWarrantyClaimNotFoundError,
  handymanServiceWarrantyClaimNotEligibleError,
  handymanServiceWarrantyClaimConflictError,
  handymanServiceWarrantyClaimIllegalTransitionError,
  handymanServiceWarrantyClaimEvidenceRequiredError,
  handymanServiceWarrantyClaimEvidenceInvalidError,
  handymanServiceWarrantyClaimNotAuthorizedError,
  handymanServiceWarrantyClaimValidationError,
} from './handyman-service-warranty-claim.errors';

export { handymanServiceWarrantyClaimRepository }
  from './handyman-service-warranty-claim.repository';

export {
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
  approveHandymanServiceWarrantyClaim,
  rejectHandymanServiceWarrantyClaim,
  withdrawHandymanServiceWarrantyClaim,
} from './handyman-service-warranty-claim.service';

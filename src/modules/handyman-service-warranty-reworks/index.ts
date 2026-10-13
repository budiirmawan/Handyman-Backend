/**
 * CR-HM-15 PART 03 — Handyman FREE WARRANTY REWORK barrel.
 * Rework bound to the APPROVED claim and, through it, to the service
 * warranty and its ORIGINAL execution scope, with the state-gated
 * PROPOSE/ACCEPT/START/COMPLETE/VERIFY ladder and a read-only CR-HM-10
 * evidence + QC verification bind. No HTTP/OpenAPI, no chargeable
 * additional-work execution (PART 04), no pricing/payment/settlement, no
 * FM/SaaS coupling.
 */

export {
  HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_REWORK_EVENT_TYPES,
  HANDYMAN_SERVICE_WARRANTY_REWORK_ACTIONS,
  isHandymanServiceWarrantyReworkStatus,
  isHandymanServiceWarrantyReworkEventType,
  isHandymanServiceWarrantyReworkAction,
} from './handyman-service-warranty-rework.types';
export type {
  HandymanServiceWarrantyReworkStatus,
  HandymanServiceWarrantyReworkEventType,
  HandymanServiceWarrantyReworkAction,
  HandymanServiceWarrantyReworkRecord,
  HandymanServiceWarrantyReworkEventRecord,
  NewHandymanServiceWarrantyRework,
  NewHandymanServiceWarrantyReworkEvent,
  ProposeHandymanServiceWarrantyReworkInput,
  HandymanServiceWarrantyReworkTransitionInput,
  CompleteHandymanServiceWarrantyReworkInput,
  VerifyHandymanServiceWarrantyReworkInput,
  HandymanServiceWarrantyReworkCommandResult,
} from './handyman-service-warranty-rework.types';

export {
  HANDYMAN_NOT_WARRANTY_REWORK_AUTHORITY,
  isNotWarrantyReworkAuthorityAlias,
  assertHandymanServiceWarrantyReworkIntakeEligible,
  nextHandymanServiceWarrantyReworkStatus,
  nextHandymanServiceWarrantyReworkHeadStatus,
} from './handyman-service-warranty-rework.lifecycle';
export type {
  HandymanNotWarrantyReworkAuthority,
} from './handyman-service-warranty-rework.lifecycle';

export {
  handymanServiceWarrantyReworkNotFoundError,
  handymanServiceWarrantyReworkNotEligibleError,
  handymanServiceWarrantyReworkConflictError,
  handymanServiceWarrantyReworkIllegalTransitionError,
  handymanServiceWarrantyReworkEvidenceRequiredError,
  handymanServiceWarrantyReworkEvidenceInvalidError,
  handymanServiceWarrantyReworkQcInvalidError,
  handymanServiceWarrantyReworkNotAuthorizedError,
  handymanServiceWarrantyReworkValidationError,
} from './handyman-service-warranty-rework.errors';

export { handymanServiceWarrantyReworkRepository }
  from './handyman-service-warranty-rework.repository';

export {
  proposeHandymanServiceWarrantyRework,
  authorizeHandymanServiceWarrantyRework,
  startHandymanServiceWarrantyRework,
  completeHandymanServiceWarrantyRework,
  verifyHandymanServiceWarrantyRework,
} from './handyman-service-warranty-rework.service';

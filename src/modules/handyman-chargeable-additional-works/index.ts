/**
 * CR-HM-15 PART 04 — CHARGEABLE ADDITIONAL-WORK SEPARATION barrel.
 * A SEPARATE record family for the APPROVED-or-REJECTED claim path: the
 * chargeable scope is proposed by the provider/lead and accepted or
 * rejected by the customer side, binding to the claim and, through it, to
 * the service warranty and its ORIGINAL execution scope / BAST. Free
 * warranty rework is never converted into chargeable work (B8) and the
 * warranty head is never mutated here. Acceptance emits the CR-HM-13
 * payment trigger fact; no amount/pricing/ledger/payment/settlement, no
 * FM/SaaS, no API.
 */

export {
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES,
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_EVENT_TYPES,
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ACTIONS,
  isHandymanChargeableAdditionalWorkStatus,
  isHandymanChargeableAdditionalWorkEventType,
  isHandymanChargeableAdditionalWorkAction,
} from './handyman-chargeable-additional-work.types';
export type {
  HandymanChargeableAdditionalWorkStatus,
  HandymanChargeableAdditionalWorkEventType,
  HandymanChargeableAdditionalWorkAction,
  HandymanChargeableAdditionalWorkRecord,
  HandymanChargeableAdditionalWorkEventRecord,
  NewHandymanChargeableAdditionalWork,
  NewHandymanChargeableAdditionalWorkEvent,
  ProposeHandymanChargeableAdditionalWorkInput,
  HandymanChargeableAdditionalWorkDecisionInput,
  HandymanChargeableAdditionalWorkCommandResult,
  HandymanChargeablePaymentTriggerFact,
} from './handyman-chargeable-additional-work.types';

export {
  HANDYMAN_NOT_CHARGEABLE_ADDITIONAL_WORK_AUTHORITY,
  isNotChargeableAdditionalWorkAuthorityAlias,
  assertHandymanChargeableAdditionalWorkIntakeEligible,
  assertHandymanChargeableAdditionalWorkFreeReworkSeparated,
  nextHandymanChargeableAdditionalWorkStatus,
  nextHandymanChargeableAdditionalWorkHeadStatus,
} from './handyman-chargeable-additional-work.lifecycle';
export type {
  HandymanNotChargeableAdditionalWorkAuthority,
} from './handyman-chargeable-additional-work.lifecycle';

export {
  handymanChargeableAdditionalWorkNotFoundError,
  handymanChargeableAdditionalWorkNotEligibleError,
  handymanChargeableAdditionalWorkConflictError,
  handymanChargeableAdditionalWorkFreeReworkConflictError,
  handymanChargeableAdditionalWorkIllegalTransitionError,
  handymanChargeableAdditionalWorkNotAuthorizedError,
  handymanChargeableAdditionalWorkValidationError,
} from './handyman-chargeable-additional-work.errors';

export { handymanChargeableAdditionalWorkRepository }
  from './handyman-chargeable-additional-work.repository';

export {
  proposeHandymanChargeableAdditionalWork,
  acceptHandymanChargeableAdditionalWork,
  rejectHandymanChargeableAdditionalWork,
} from './handyman-chargeable-additional-work.service';

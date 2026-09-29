/**
 * CR-HM-12 PART 01 — Handyman commercial agreement aggregate barrel.
 * Domain module ONLY: no controller, no routes, no HTTP, no OpenAPI.
 * Pricing modes (PART 02), material basis (PART 03), BM fee rules
 * (PART 04) and the published read contract (PART 05) bind to the
 * exact version id — never to "the current version".
 */

export {
  HANDYMAN_COMMERCIAL_AGREEMENT_STATUSES,
  HANDYMAN_COMMERCIAL_AGREEMENT_EVENT_TYPES,
  isHandymanCommercialAgreementStatus,
  isHandymanCommercialAgreementEventType,
} from './handyman-commercial-agreement.types';
export type {
  HandymanCommercialAgreementStatus,
  HandymanCommercialAgreementEventType,
  HandymanCommercialAgreementRecord,
  HandymanCommercialAgreementVersionRecord,
  HandymanCommercialAgreementEventRecord,
  NewHandymanCommercialAgreement,
  NewHandymanCommercialAgreementVersion,
  NewHandymanCommercialAgreementEvent,
} from './handyman-commercial-agreement.types';

export {
  handymanCommercialAgreementNotFoundError,
  handymanCommercialAgreementVersionNotFoundError,
  handymanCommercialAgreementIllegalTransitionError,
  handymanCommercialAgreementActiveExistsError,
  handymanCommercialAgreementClientConflictError,
  handymanCommercialAgreementNotEffectiveAtAsOfError,
  handymanCommercialAgreementValidationError,
} from './handyman-commercial-agreement.errors';

export {
  nextHandymanCommercialAgreementVersionStatus,
  parseHandymanAgreementTimestamp,
  assertHandymanAgreementSupersessionWindow,
} from './handyman-commercial-agreement.lifecycle';

export { handymanCommercialAgreementRepository }
  from './handyman-commercial-agreement.repository';

export {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion,
  resolveHandymanCommercialAgreementAt,
} from './handyman-commercial-agreement.service';
export type {
  HandymanCommercialAgreementPrepareInput,
  HandymanCommercialAgreementActivateInput,
  HandymanCommercialAgreementSupersedeInput,
  HandymanCommercialAgreementCommandResult,
} from './handyman-commercial-agreement.service';

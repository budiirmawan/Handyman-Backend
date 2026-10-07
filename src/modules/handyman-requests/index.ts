/**
 * CR-HM-02 — Handyman request intake module (sibling Handyman-owned request
 * entity per frozen D3; see docs/handyman/CR-HM-02_START_GOVERNANCE.md).
 */
export { handymanServiceRequestRepository } from './handyman-service-request.repository';
export {
  createHandymanServiceRequest,
  getHandymanServiceRequestDetail,
  handymanServiceRequestService,
  listHandymanServiceRequests,
} from './handyman-service-request.service';
export {
  handymanServiceRequestAlreadyExistsError,
  handymanServiceRequestScopeMismatchError,
} from './handyman-service-request.errors';
export {
  HANDYMAN_SERVICE_REQUEST_STATUSES,
  isHandymanServiceRequestStatus,
} from './handyman-service-request.types';
export type {
  CreateHandymanServiceRequestInput,
  HandymanCustomerCareServiceRequestRecord,
  HandymanRequestAttributionProvenance,
  HandymanServiceRequestListFilters,
  HandymanServiceRequestRecord,
  HandymanServiceRequestStatus,
  NewHandymanServiceRequest,
  PublicHandymanCustomerCareServiceRequest,
  PublicHandymanServiceRequest,
} from './handyman-service-request.types';
/**
 * CR-HM-03 PART 01 — bounded triage foundation exports (FROZEN F1/F2/F6/F7;
 * decision chain starts here; inspection/diagnosis/referral remain later
 * PARTs of the same CR).
 */
export {
  handymanRequestTriageRepository,
} from './handyman-request-triage.repository';
export {
  recordHandymanRequestTriage,
  getHandymanRequestTriage,
  handymanServiceRequestTriageService,
} from './handyman-request-triage.service';
export {
  handymanServiceRequestAlreadyTriagedError,
  handymanServiceRequestNotFoundError,
  handymanServiceRequestNotIntakeError,
} from './handyman-request-triage.errors';
export {
  HANDYMAN_TRIAGE_DISPOSITIONS,
  isHandymanTriageDisposition,
} from './handyman-request-triage.types';
export type {
  CreateHandymanRequestTriageInput,
  HandymanRequestTriageDecisionRecord,
  HandymanTriageDisposition,
  NewHandymanRequestTriageRecord,
  PublicHandymanRequestTriage,
} from './handyman-request-triage.types';
/**
 * CR-HM-03 PART 02 — bounded inspection record exports (FROZEN F1/F2/F3/F6/F7;
 * INSPECTION_REQUIRED → DIAGNOSIS only).
 */
export {
  handymanRequestInspectionRepository,
} from './handyman-request-inspection.repository';
export {
  recordHandymanInspection,
  getHandymanRequestInspection,
  handymanServiceRequestInspectionService,
} from './handyman-request-inspection.service';
export {
  handymanServiceRequestAlreadyInspectedError,
  handymanServiceRequestNotInspectionRequiredError,
} from './handyman-request-inspection.errors';
export {
  HANDYMAN_INSPECTION_RESULTS,
  isHandymanInspectionResult,
} from './handyman-request-inspection.types';
export type {
  CreateHandymanInspectionInput,
  HandymanInspectionResult,
  HandymanRequestInspectionRecord,
  NewHandymanRequestInspectionRecord,
  PublicHandymanRequestInspection,
} from './handyman-request-inspection.types';
/**
 * CR-HM-03 PART 03 — diagnosis + FROZEN F4/F9 scope authority exports
 * (server-derived classification + READY_FOR_NEXT_STEP / terminal REFERRED
 * projection only; no referral/provider/FM/quotation/work-order surface).
 */
export {
  handymanRequestDiagnosisRepository,
} from './handyman-request-diagnosis.repository';
export {
  recordHandymanDiagnosis,
  getHandymanRequestDiagnosis,
  handymanServiceRequestDiagnosisService,
} from './handyman-request-diagnosis.service';
export {
  handymanDiagnosisRecommendationInvalidError,
  handymanServiceRequestAlreadyDiagnosedError,
  handymanServiceRequestNotInDiagnosisError,
} from './handyman-request-diagnosis.errors';
export {
  HANDYMAN_SCOPE_CLASSIFICATIONS,
  SCOPE_CLASS_TO_CLASSIFICATION,
  SCOPE_CLASS_TO_REQUEST_STATUS,
} from './handyman-request-diagnosis.types';
export type {
  CreateHandymanDiagnosisInput,
  HandymanRequestDiagnosisRecord,
  HandymanScopeClassification,
  NewHandymanRequestDiagnosisRecord,
  PublicHandymanRequestDiagnosis,
} from './handyman-request-diagnosis.types';
/**
 * CR-HM-03 PART 04 — referral foundation exports (FROZEN F4/F5/F9;
 * diagnosis-derived eligibility/type/target only; request state preserved;
 * no provider/crew/work-order/quotation/FM surface).
 */
export {
  handymanRequestReferralRepository,
} from './handyman-request-referral.repository';
export {
  recordHandymanReferral,
  getHandymanRequestReferral,
  handymanServiceRequestReferralService,
} from './handyman-request-referral.service';
export {
  handymanReferralNotEligibleError,
  handymanServiceRequestAlreadyReferredError,
} from './handyman-request-referral.errors';
export {
  HANDYMAN_REFERRAL_TYPES,
  CLASSIFICATION_TO_REFERRAL_TYPE,
  isReferralEligibleClassification,
} from './handyman-request-referral.types';
export type {
  CreateHandymanReferralInput,
  HandymanReferralType,
  HandymanRequestReferralRecord,
  NewHandymanRequestReferralRecord,
  PublicHandymanRequestReferral,
} from './handyman-request-referral.types';

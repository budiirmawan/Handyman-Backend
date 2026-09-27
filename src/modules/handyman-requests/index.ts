/**
 * CR-HM-02 — Handyman request intake module (sibling Handyman-owned request
 * entity per frozen D3; see docs/handyman/CR-HM-02_START_GOVERNANCE.md).
 */
export { handymanServiceRequestRepository } from './handyman-service-request.repository';
export {
  createHandymanServiceRequest,
  handymanServiceRequestService,
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
  HandymanServiceRequestRecord,
  HandymanServiceRequestStatus,
  NewHandymanServiceRequest,
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

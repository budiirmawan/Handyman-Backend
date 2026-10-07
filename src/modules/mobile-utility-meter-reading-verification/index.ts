/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — mobile field reading verification.
 *
 * Bounded module: src/modules/mobile-utility-meter-reading-verification/
 *
 * The field-safe surface over a reading a technician is assigned to: its BE-18F
 * evidence (upload / list / readiness / soft remove), the EXISTING OCR candidates
 * staged from that evidence as SUGGESTIONS plus the human confirm / reject
 * decision on one of them, and the persisted BE-18G → BE-18J downstream abnormal
 * signal as a pure read projection. It also supplies the enriched handler for
 * PART 01's reading DETAIL route, which stays registered in PART 01's router.
 *
 * It owns addressing (Reading Due + reading), authority (the reading-keyed
 * `assertUtilityMeterReadingFieldActor` seam over PART 00) and bounded
 * projection. It does NOT own an evidence engine, an OCR engine or an
 * abnormality engine: every write delegates to the authoritative module that
 * already exists (BE-18F, BE-18, the shared storage abstraction) and every read
 * projects persisted rows.
 *
 * Out of scope by design: candidate creation, OCR/vision, abnormality rules or
 * evaluation, consumption creation, QR, BE-25H `METER_READING` (which remains
 * BE-10C), and any billing or tariff involvement. Recheck/correction,
 * `availableActions` and the BE-18 offline sync kind were this module's declared
 * "later PART" boundary and are delivered by CR-BE-RN12-METER-FIELD-01 PART 03
 * (src/modules/mobile-utility-meter-reading-lifecycle/), which extends the
 * reading DETAIL projection rather than replacing it.
 */

export {
  confirmMobileReadingOcrCandidateHandler,
  getMobileUtilityMeterReadingDetailHandler,
  listMobileReadingAbnormalSignalsHandler,
  listMobileReadingEvidenceHandler,
  listMobileReadingOcrCandidatesHandler,
  rejectMobileReadingOcrCandidateHandler,
  removeMobileReadingEvidenceHandler,
  uploadMobileReadingEvidenceHandler,
  validateMobileReadingEvidenceHandler,
} from './mobile-utility-meter-reading-verification.controller';

export { createMobileUtilityMeterReadingVerificationRouter } from './mobile-utility-meter-reading-verification.routes';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — `authorizeFieldReading` is exported from
 * the service below so the recheck commands are authorized by the SAME rule, in
 * the SAME order, as every route here. One field authority, one implementation.
 */
export {
  authorizeFieldReading,
  confirmMobileReadingOcrCandidate,
  getMobileUtilityMeterReadingDetail,
  listMobileReadingAbnormalSignals,
  listMobileReadingEvidence,
  listMobileReadingOcrCandidates,
  mobileUtilityMeterReadingVerificationService,
  rejectMobileReadingOcrCandidate,
  removeMobileReadingEvidence,
  submitMobileReadingEvidenceFile,
  validateMobileReadingEvidence,
} from './mobile-utility-meter-reading-verification.service';

export type { MobileReadingEvidenceFile } from './mobile-utility-meter-reading-verification.service';

export {
  parseMobileOcrCandidateIdParam,
  parseMobileReadingEvidenceIdParam,
  parseMobileReadingEvidenceUploadFields,
  parseMobileReadingOcrConfirmBody,
  parseMobileReadingOcrRejectBody,
} from './mobile-utility-meter-reading-verification.validation';

export {
  MOBILE_READING_ABNORMAL_SIGNAL_LIMIT,
  MOBILE_READING_EVIDENCE_BODY_FIELDS,
  MOBILE_READING_EVIDENCE_DERIVED_FIELDS,
  MOBILE_READING_EVIDENCE_SUMMARY_LIMIT,
  MOBILE_READING_OCR_CANDIDATE_LIMIT,
  MOBILE_READING_OCR_CONFIRM_BODY_FIELDS,
  MOBILE_READING_OCR_DERIVED_FIELDS,
  MOBILE_READING_OCR_REJECT_BODY_FIELDS,
} from './mobile-utility-meter-reading-verification.types';

export type {
  MobileReadingAbnormalSignal,
  MobileReadingAbnormalSignalProjection,
  MobileReadingEvidenceItem,
  MobileReadingEvidenceSummary,
  MobileReadingEvidenceUploadInput,
  MobileReadingEvidenceUploadStatus,
  MobileReadingOcrCandidateSuggestion,
  MobileReadingOcrConfirmInput,
  MobileReadingOcrDecisionResult,
  MobileReadingOcrRejectInput,
  MobileUtilityMeterReadingDetail,
} from './mobile-utility-meter-reading-verification.types';

import type { UtilityMeterReadingEvidenceReadiness } from '../utility-meter-reading-evidence';
import type {
  UtilityAbnormalConsumptionStatus,
  UtilityAbnormalityComparisonMode,
  UtilityAbnormalityType,
} from '../utility-abnormal-consumptions';
import type { UtilityOcrStatus } from '../utility-ocr-candidates';
import type { MobileUtilityMeterReading } from '../mobile-utility-meter-reading/mobile-utility-meter-reading.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — mobile field reading VERIFICATION contract.
 *
 * Three read projections and one human decision, all hanging off a reading a
 * field actor is already authorized on:
 *
 *   1. EVIDENCE   — the BE-18F reading evidence of that reading, plus its
 *                   canonical readiness. Upload / list / remove reuse the BE-18F
 *                   service; nothing here is a second evidence engine.
 *   2. OCR        — the EXISTING `utility_meter_ocr_candidates` rows staged from
 *                   that reading's PHOTO evidence, exposed as SUGGESTIONS, plus
 *                   the field actor's confirm / reject decision on one of them.
 *   3. ABNORMAL   — the persisted BE-18G → BE-18J downstream signal linked to
 *                   that reading, as a pure READ projection.
 *
 * WHAT NONE OF THIS IS
 * --------------------
 * No OCR / vision engine and no candidate-from-image: a candidate is only ever
 * read here, never produced. No abnormality rule engine, threshold or evaluator:
 * a signal is only ever read here, never computed. No consumption row is created,
 * no `current − previous` arithmetic is performed, no recheck or correction
 * lifecycle exists, and no `availableActions` token is minted for a reading.
 *
 * EVIDENCE READINESS IS NOT READING VALIDITY
 * ------------------------------------------
 * `evidenceValidation.ready === false` means "a persisted BE-07 requirement on
 * this reading does not yet have enough ACTIVE submissions". It says NOTHING
 * about whether the reading is genuine, and it never gates, rejects, reopens or
 * deletes one: BE-18E readings are append-only and BE-18F explicitly reports
 * readiness without enforcing it. A reading with no requirements at all is
 * `ready: true` — no photo obligation is invented anywhere in this contract.
 */

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

/**
 * Every projection embedded in the reading DETAIL is bounded, because the detail
 * is fetched on a phone in a corridor: an unbounded join could make one reading
 * response carry a whole meter's evidence history. The dedicated list routes are
 * the place to page through more.
 */
export const MOBILE_READING_EVIDENCE_SUMMARY_LIMIT = 20;
export const MOBILE_READING_OCR_CANDIDATE_LIMIT = 20;
export const MOBILE_READING_ABNORMAL_SIGNAL_LIMIT = 20;

/* -------------------------------------------------------------------------
 * Evidence
 * ---------------------------------------------------------------------- */

/** Mirrors the BE-25E mobile upload states — the bytes are either there or not. */
export type MobileReadingEvidenceUploadStatus = 'UPLOADED' | 'PENDING';

/**
 * One BE-18F reading-evidence submission, in the MOBILE projection.
 *
 * `fileReference` is deliberately absent even though BE-18F's management shape
 * carries it: the mobile evidence contract never exposes an internal storage
 * path (BE-25E), and `uploadStatus` / `fileAvailable` already tell a client
 * everything it needs about retrievability. The stored key stays server-side.
 */
export type MobileReadingEvidenceItem = {
  id: string;
  /** BE-18F's own reading linkage — the reading this evidence belongs to. */
  meterReadingId: string;
  evidenceRequirementId: string | null;
  evidenceType: 'PHOTO' | 'DOCUMENT' | 'SIGNATURE';
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  uploadStatus: MobileReadingEvidenceUploadStatus;
  /** True when the file bytes are retrievable (storage-backed). */
  fileAvailable: boolean;
  submittedByUserId: string | null;
  /** BE-07 lifecycle: ACTIVE, or REMOVED once soft-removed. */
  status: string;
  createdAt: string;
};

/** Bounded evidence state of a reading, embedded in the reading DETAIL. */
export type MobileReadingEvidenceSummary = {
  /** Count of ACTIVE submissions — REMOVED rows are history, not evidence. */
  activeTotal: number;
  /** ACTIVE counts per BE-07 evidence type; all three keys are always present. */
  activeByType: {
    PHOTO: number;
    DOCUMENT: number;
    SIGNATURE: number;
  };
  /** True when `activeTotal` exceeds the embedded bound and `items` is a prefix. */
  truncated: boolean;
  items: MobileReadingEvidenceItem[];
};

/* -------------------------------------------------------------------------
 * OCR — suggestion only
 * ---------------------------------------------------------------------- */

/**
 * One EXISTING OCR candidate, exposed as a SUGGESTION.
 *
 * Every field is a persisted column of `utility_meter_ocr_candidates` — nothing
 * is computed, and above all there is NO verdict field: no `matchesReading`,
 * no `shouldAccept`, no `recommended`. The candidate value is a suggestion a
 * human reads next to the reading they already recorded; the comparison is the
 * human's, and the ONLY machine check is the canonical one BE-18 already applies
 * when a decision is recorded (`candidateReadingValue` must equal the accepted
 * reading's `readingValue`, same Meter, same Building).
 *
 * `clientId` / `buildingId` / `meterId` are omitted for the same reason PART 01
 * omits them from the reading DTO: the actor is already scoped to exactly one
 * meter and Building by the field-authority seam, and echoing them back would
 * only invite a client to treat them as inputs.
 */
export type MobileReadingOcrCandidateSuggestion = {
  id: string;
  /** The PHOTO evidence submission this candidate was staged from. */
  evidenceId: string;
  candidateReadingValue: number;
  /** 0..1 as staged, or null when the stager recorded no confidence. */
  confidence: number | null;
  status: UtilityOcrStatus;
  /** Set once ACCEPTED: the canonical reading the suggestion was confirmed against. */
  acceptedReadingId: string | null;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  decisionNotes: string | null;
  createdAt: string;
};

/**
 * The outcome of a field confirm / reject, in the same suggestion shape so a
 * client can replace its local copy without a second model.
 *
 * The decision is TERMINAL: `utility_meter_ocr_decision_check` (0281) allows a
 * row to leave PENDING_REVIEW exactly once, and BE-18's `repository.decide`
 * carries `WHERE status = 'PENDING_REVIEW'`, so a second decision on the same
 * candidate is 409 `UTILITY_OCR_DECISION_FINAL` no matter who asks.
 */
export type MobileReadingOcrDecisionResult = {
  candidate: MobileReadingOcrCandidateSuggestion;
};

/* -------------------------------------------------------------------------
 * Abnormal signal — read projection only
 * ---------------------------------------------------------------------- */

/**
 * One PERSISTED BE-18J abnormal consumption linked to this reading through
 * BE-18G.
 *
 * The link is followed, never evaluated:
 * `utility_meter_consumptions.current_reading_id = reading.id` →
 * `utility_abnormal_consumptions.consumption_id = that consumption`. Both hops
 * use the EXISTING repository reads (`findByCurrentReading`,
 * `listByConsumption`); no new query semantics and no new rule are introduced.
 *
 * Every field is a persisted column, renamed nowhere. Omitted on purpose:
 *   - `availableActions` — BE-18J derives RESOLVE / DISMISS / LINK_FINDING for
 *     the MANAGEMENT closure workflow. A field actor holds none of those
 *     authorities, so publishing the tokens here would advertise actions this
 *     contract cannot perform. Closure stays BE-18J's.
 *   - `clientId` / `buildingId` / `meterId` / `utilityType` — identical to the
 *     reading's own context, which the caller already has.
 *   - `tenantAssignmentId` / `tenantCompanyId` — BE-18D billing provenance,
 *     excluded from the field contract exactly as PART 01 excluded it.
 *   - the `meter` / `uom` / `consumption` / `rule` / `finding` enrichments —
 *     read-through management context, not field workflow.
 */
export type MobileReadingAbnormalSignal = {
  id: string;
  /** The BE-18G consumption this signal was detected on. */
  consumptionId: string;
  /** The BE-18J rule that fired, or null for a rule-less detection. */
  ruleId: string | null;
  abnormalityType: UtilityAbnormalityType;
  comparisonMode: UtilityAbnormalityComparisonMode;
  detectedValue: number;
  referenceValue: number | null;
  thresholdValue: number | null;
  uomId: string;
  periodStart: string;
  periodEnd: string;
  detectedAt: string;
  detectedByUserId: string | null;
  /** OPEN, RESOLVED or DISMISSED — BE-18J's lifecycle, reported as persisted. */
  status: UtilityAbnormalConsumptionStatus;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolutionNotes: string | null;
  /** BE-09 Finding reference; the Finding itself stays BE-09's authority. */
  findingId: string | null;
  notes: string | null;
};

/**
 * The bounded abnormal-signal projection of a reading.
 *
 * WHY THE WRAPPER EXISTS — the meaning of an empty list
 * -----------------------------------------------------
 * `signals: []` means exactly one thing: NO PERSISTED abnormal consumption is
 * linked to this reading. It does NOT mean the reading was evaluated and found
 * normal, and it does NOT mean consumption was calculated at all. Those are
 * different states and a bare array cannot distinguish them, so the projection
 * says which one it is:
 *
 *   - `consumptionId: null`      → BE-18G has not persisted a consumption whose
 *                                  closing reading is this one. Nothing has been
 *                                  derived from this reading yet.
 *   - `consumptionId` set, empty → a consumption exists; no abnormality row is
 *     `signals`                    linked to it. Still NOT a verdict: BE-18J
 *                                  detection is its own command
 *                                  (`POST /utility/consumptions/:id/abnormality-evaluations`),
 *                                  and this contract never triggers it.
 *
 * `evaluated` is therefore a statement about what is PERSISTED, never about what
 * is true of the meter. No threshold, baseline or rule is read, applied or
 * re-implemented here.
 */
export type MobileReadingAbnormalSignalProjection = {
  /** The BE-18G consumption anchored on this reading, when one is persisted. */
  consumptionId: string | null;
  /** True only when BE-18J abnormality rows are persisted for that consumption. */
  evaluated: boolean;
  /** True when more signals are persisted than the embedded bound carries. */
  truncated: boolean;
  signals: MobileReadingAbnormalSignal[];
};

/* -------------------------------------------------------------------------
 * Reading DETAIL
 * ---------------------------------------------------------------------- */

/**
 * The mobile field reading DETAIL: PART 01's bounded reading DTO plus the four
 * additive PART 02 projections.
 *
 * Strictly additive — every PART 01 field keeps its exact name, type and value,
 * so a client built against PART 01 reads this response unchanged. The LIST
 * route (`GET .../readings`) deliberately stays on the lightweight PART 01 DTO:
 * history is a scroll, the detail is where verification lives.
 *
 * The `reading` facts themselves are never modified by anything in this
 * contract, whatever the projections say.
 */
export type MobileUtilityMeterReadingDetail = MobileUtilityMeterReading & {
  /** BE-18F canonical readiness, verbatim. Reported, never enforced. */
  evidenceValidation: UtilityMeterReadingEvidenceReadiness;
  evidenceSummary: MobileReadingEvidenceSummary;
  /** Bounded, newest first. SUGGESTIONS only — never an authority. */
  ocrCandidates: MobileReadingOcrCandidateSuggestion[];
  abnormalSignals: MobileReadingAbnormalSignalProjection;
};

/* -------------------------------------------------------------------------
 * Field upload input
 * ---------------------------------------------------------------------- */

/**
 * The complete allowlist of the field evidence upload's multipart TEXT fields.
 * The bytes themselves travel in the multipart `file` field.
 *
 * `capturedAt` is caller-supplied because it is a domain fact about when the
 * photo was taken, exactly as `readingAt` is for the reading (PART 01).
 */
export const MOBILE_READING_EVIDENCE_BODY_FIELDS = [
  'evidenceType',
  'evidenceRequirementId',
  'capturedAt',
  'originalFileName',
] as const;

/**
 * Authority facts a field client must never supply for reading evidence. Each is
 * refused with the reason it is server-derived rather than silently dropped, so
 * a client cannot discover by trial that one of them was quietly ignored — the
 * PART 01 convention, applied to evidence.
 */
export const MOBILE_READING_EVIDENCE_DERIVED_FIELDS: Readonly<
  Record<string, string>
> = {
  meterReadingId: 'meterReadingId comes from the route path.',
  readingId: 'readingId comes from the route path.',
  readingDueId: 'readingDueId comes from the route path.',
  clientId: 'clientId is derived from the Meter Reading (BE-18E).',
  buildingId: 'buildingId is derived from the Meter Reading (BE-18E).',
  meterId: 'meterId is derived from the Meter Reading (BE-18E).',
  submittedByUserId: 'submittedByUserId is the authenticated actor.',
  fileReference:
    'fileReference is the backend-generated storage key; a client-supplied path never reaches storage.',
  storageKey:
    'fileReference is the backend-generated storage key; a client-supplied path never reaches storage.',
  mimeType: 'mimeType is taken from the uploaded file itself.',
  fileSize: 'fileSize is taken from the uploaded file itself.',
  id: 'id is generated by the backend.',
  status: 'status is managed by the BE-07 evidence lifecycle.',
  contentSha256:
    'contentSha256 is computed server-side from the exact uploaded bytes; no caller-supplied hash is ever accepted.',
  hashAlgorithm: 'hashAlgorithm is server-owned (CR-BE-DOC-CONTROL-01).',
  executionType: 'executionType is UTILITY_METER_READING for this route.',
  executionId: 'executionId is the reading from the route path.',
  evidenceId: 'evidenceId is generated by the backend.',
  createdAt: 'createdAt is generated by the backend.',
  updatedAt: 'updatedAt is generated by the backend.',
};

/** Parsed, normalized field evidence upload input (bytes handled separately). */
export type MobileReadingEvidenceUploadInput = {
  evidenceType: 'PHOTO' | 'DOCUMENT' | 'SIGNATURE';
  evidenceRequirementId?: string;
  capturedAt?: string;
  originalFileName?: string;
};

/**
 * Authority facts a field client must never supply when deciding an OCR
 * candidate. The reading being confirmed against comes from the route path; the
 * candidate comes from the route path; the actor comes from the session.
 *
 * `readingAt` and `meterReadingId` are the load-bearing refusals: BE-18's
 * `acceptUtilityOcrCandidate` CREATES a new reading when it is handed a
 * `readingAt`, and links an arbitrary reading when handed a `meterReadingId`.
 * A field confirmation may do neither — it exists to confirm or reject a
 * suggestion against the reading the technician ALREADY recorded through
 * PART 01. `readingDueId` is refused for the same reason: the due is already
 * COMPLETED by that submission, and re-sending it would attempt a second
 * completion.
 */
export const MOBILE_READING_OCR_DERIVED_FIELDS: Readonly<
  Record<string, string>
> = {
  readingAt:
    'readingAt would make the backend CREATE a reading; a field confirmation only links the reading already recorded for this due.',
  meterReadingId:
    'meterReadingId comes from the route path; a field confirmation cannot point a candidate at another reading.',
  readingDueId:
    'readingDueId comes from the route path, and the due is already completed by the field submission.',
  candidateReadingValue:
    'candidateReadingValue is the staged suggestion; a decision never restates or edits it.',
  confidence: 'confidence is part of the staged suggestion and is never edited by a decision.',
  evidenceId: 'evidenceId is the candidate’s own source evidence.',
  meterId: 'meterId is the candidate’s own meter.',
  buildingId: 'buildingId is the candidate’s own Building.',
  clientId: 'clientId is the candidate’s own Client.',
  status: 'status is the outcome of the decision, never an input to it.',
  acceptedReadingId: 'acceptedReadingId is set by the backend from the route path reading.',
  verifiedByUserId: 'verifiedByUserId is the authenticated actor.',
  verifiedAt: 'verifiedAt is the backend timestamp of the decision.',
  id: 'id is generated by the backend.',
  createdAt: 'createdAt is generated by the backend.',
  updatedAt: 'updatedAt is generated by the backend.',
};

/** The complete allowlist of a field OCR decision body. */
export const MOBILE_READING_OCR_CONFIRM_BODY_FIELDS = ['notes'] as const;
export const MOBILE_READING_OCR_REJECT_BODY_FIELDS = ['decisionNotes'] as const;

/** Parsed field confirm body. */
export type MobileReadingOcrConfirmInput = {
  notes?: string | null;
};

/** Parsed field reject body — `decisionNotes` is required by BE-18's own rule. */
export type MobileReadingOcrRejectInput = {
  decisionNotes: string;
};

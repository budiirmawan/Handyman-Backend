/**
 * BE-25E — Mobile Evidence Upload Contract types.
 *
 * The mobile evidence contract: a single-call evidence upload and a reference
 * read model. It composes the BE-07 Evidence authority (evidence_submissions +
 * evidence_requirements) and the CR-BE-API-01 PART 03 storage abstraction —
 * no separate mobile evidence engine, no bytes in PostgreSQL, and no internal
 * storage path is ever exposed (the backend-generated storage key stays
 * server-side).
 */

export type MobileEvidenceUploadStatus = 'UPLOADED' | 'PENDING';

/**
 * MOB-C06 PART 01 — the execution/parent kinds the mobile evidence contract
 * accepts. The three Finding kinds reuse the shared BE-07 evidence parent
 * model (CR-BE-EVD-01 PART 01 / migration 0277):
 *   - FINDING             → the authoritative Finding itself,
 *   - FINDING_REWORK      → an authoritative finding_rework_cycles row,
 *   - FINDING_VERIFICATION→ an authoritative PENDING `reviews` row
 *                           (target_type = 'FINDING').
 * No second mobile Finding authority engine exists — parents are resolved by
 * the shared `loadEvidenceExecution` resolver exactly like the generic
 * Finding evidence endpoints.
 */
export const MOBILE_EVIDENCE_EXECUTION_TYPES = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'FINDING',
  'FINDING_REWORK',
  'FINDING_VERIFICATION',
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 02 — the BE-18F Reading Evidence parent
   * (`evidence_submissions.execution_type = 'UTILITY_METER_READING'`,
   * `execution_id = utility_meter_readings.id`).
   *
   * Admitted, not invented: BE-18F already writes those rows and migration 0281
   * already allows the value at the database level. Until now the mobile
   * contract did not know the kind, so a reading's photo read through
   * `GET /mobile/evidence/:evidenceId` fell into the FORM_INSTANCE fallback and
   * came back with a null parent — a broken projection of a row that was
   * perfectly authoritative.
   *
   * Every existing kind is preserved verbatim; none is removed, reordered or
   * reinterpreted, and no second mobile evidence engine or table is added.
   */
  'UTILITY_METER_READING',
  /**
   * CR-BE-RN13-CLEANING-EVIDENCE-MOBILE-01 — the canonical Daily Cleaning task
   * parent (`execution_type = 'DAILY_CLEANING'`, `execution_id = generated_tasks.id / reference.taskId`).
   */
  'DAILY_CLEANING',
] as const;

export type MobileEvidenceExecutionType =
  (typeof MOBILE_EVIDENCE_EXECUTION_TYPES)[number];

/** Client / Building context of the evidence. */
export type MobileEvidenceBuilding = {
  id: string;
  code: string;
  name: string;
};

/** The validated evidence requirement the submission satisfies (if any). */
export type MobileEvidenceRequirementReference = {
  id: string;
  evidenceType: 'PHOTO' | 'DOCUMENT' | 'SIGNATURE';
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
};

/** Target task/checklist/work reference of the evidence. */
export type MobileEvidenceTarget = {
  executionType: MobileEvidenceExecutionType;
  executionId: string;
  checklist: { id: string; code: string; name: string } | null;
  form: { id: string; code: string; name: string } | null;
  task: {
    taskId: string;
    occurrenceAt: string;
    taskStatus: string;
    buildingId: string | null;
  } | null;
  /**
   * MOB-C06 PART 02 — additive Finding-parent references (server-derived
   * from the stored evidence's execution_type + execution_id, never from
   * client input). Non-null only for the matching Finding-related kind.
   */
  finding: { id: string; findingNumber: string; title: string; status: string } | null;
  rework: { id: string; status: string } | null;
  verification: { id: string; status: string } | null;
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 02 — additive BE-18F Reading-parent
   * reference, server-derived from the stored evidence's `execution_type` +
   * `execution_id` and never from client input. Non-null only for
   * `UTILITY_METER_READING`; always null for every pre-existing kind, so the
   * projection of a Finding / checklist / form evidence row is byte-identical to
   * before apart from this one nullable field.
   *
   * Exactly the BE-18E reading facts, with no status invented for a reading
   * (BE-18E readings are append-only and have no status column) and no meter
   * identity beyond `meterId`: PART 00's
   * `GET /mobile/utility-reading-dues/:readingDueId/meter-context` is where a
   * field client reads meter identity, and duplicating it here would create a
   * second, divergent meter projection.
   *
   * No consumption value, no delta, no abnormality verdict and no OCR verdict is
   * carried here — the evidence contract describes the FILE and its parent, and
   * PART 02's verification surface is where suggestions and persisted signals
   * are read.
   */
  meterReading: {
    id: string;
    meterId: string;
    readingValue: number;
    readingAt: string;
    source: string;
    readingType: string;
  } | null;
};

/** File metadata + upload result of the submission. */
export type MobileEvidenceFile = {
  originalFileName: string | null;
  mimeType: string | null;
  fileSize: number;
  capturedAt: string | null;
  uploadStatus: MobileEvidenceUploadStatus;
  /** True when the file bytes are retrievable (storage-backed). */
  fileAvailable: boolean;
};

/** The full mobile evidence contract. */
export type MobileEvidenceContract = {
  id: string;
  clientId: string;
  building: MobileEvidenceBuilding | null;
  evidenceRequirement: MobileEvidenceRequirementReference | null;
  target: MobileEvidenceTarget;
  evidenceType: 'PHOTO' | 'DOCUMENT' | 'SIGNATURE';
  file: MobileEvidenceFile;
  /** Submission status (ACTIVE / REMOVED). */
  status: string;
  submittedByUserId: string;
  createdAt: string;
  updatedAt: string;
};

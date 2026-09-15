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

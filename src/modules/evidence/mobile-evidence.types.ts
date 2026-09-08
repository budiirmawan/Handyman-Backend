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
  executionType: 'FORM_INSTANCE' | 'CHECKLIST_EXECUTION';
  executionId: string;
  checklist: { id: string; code: string; name: string } | null;
  form: { id: string; code: string; name: string } | null;
  task: {
    taskId: string;
    occurrenceAt: string;
    taskStatus: string;
    buildingId: string | null;
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

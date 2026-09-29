/**
 * CR-HM-02 PART 04 — Handyman request-intake evidence types & policy
 * (frozen D1/D2). Operational intake evidence only; this is NOT
 * catalogue/material master-data media (D1 keeps those separate).
 */

/** Handyman intake kinds only: safe PHOTO semantics + bounded VIDEO. */
export const HANDYMAN_INTAKE_EVIDENCE_KINDS = ['PHOTO', 'VIDEO'] as const;
export type HandymanIntakeEvidenceKind =
  (typeof HANDYMAN_INTAKE_EVIDENCE_KINDS)[number];

export function isHandymanIntakeEvidenceKind(
  value: unknown,
): value is HandymanIntakeEvidenceKind {
  return (
    typeof value === 'string' &&
    (HANDYMAN_INTAKE_EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

/** Parent kind admitted to the shared evidence engine (migration 0379). */
export const HANDYMAN_REQUEST_EVIDENCE_PARENT = 'HANDYMAN_REQUEST' as const;

/**
 * PHOTO: byte-identical to the existing PHOTO MIME allowlist semantics
 * (evidence-file.routes `MIME_BY_EVIDENCE_TYPE.PHOTO`).
 */
export const HANDYMAN_INTAKE_PHOTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * VIDEO: explicit bounded Handyman intake policy (frozen D2). Conservative
 * mainstream container types only; bound application-side to the
 * HANDYMAN_REQUEST parent — no other parent creates VIDEO rows.
 */
export const HANDYMAN_INTAKE_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

/**
 * Maximum bytes for BOTH kinds: the existing shared evidence byte policy
 * (DB `evidence_submission_size` CHECK / `MAX_EVIDENCE_FILE_BYTES`, 50 MB).
 * VIDEO is not given a larger budget than the established platform limit.
 */
export const HANDYMAN_INTAKE_MAX_FILE_BYTES = 52_428_800;

/** File metadata bound (hygiene; existing column is free TEXT). */
export const HANDYMAN_INTAKE_FILE_NAME_MAX_LENGTH = 255;

/** Full database record (bounded view of the evidence_submissions row). */
export type HandymanIntakeEvidenceRecord = {
  id: string;
  /** Tenant-isolation root derived from the Handyman request. */
  clientId: string;
  /** Handyman request (`execution_id` of the shared submission row). */
  handymanRequestId: string;
  evidenceKind: HandymanIntakeEvidenceKind;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: Date | null;
  submittedByUserId: string | null;
  /** Server-computed SHA-256 of the stored bytes (integrity metadata). */
  contentSha256: string;
  status: 'ACTIVE' | 'REMOVED';
  createdAt: Date;
};

/** Safe public representation of an intake evidence record. */
export type PublicHandymanIntakeEvidence = Omit<
  HandymanIntakeEvidenceRecord,
  'capturedAt' | 'createdAt'
> & {
  capturedAt: string | null;
  createdAt: string;
};

/**
 * Server-side intake input. Context authority (client / company / building
 * / space) is NEVER part of input — it always derives from the Handyman
 * request.
 */
export type RecordHandymanIntakeEvidenceInput = {
  handymanRequestId: string;
  evidenceKind: HandymanIntakeEvidenceKind;
  fileName: string;
  mimeType: string;
  content: Buffer;
};

/**
 * BE-11I — Housekeeping Evidence Binding domain types.
 *
 * Reuses BE-07 Evidence Requirement and Evidence Submission primitives to bind
 * evidence (PHOTO, DOCUMENT, SIGNATURE) to Housekeeping operations.
 */

export const EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const HOUSEKEEPING_EVIDENCE_SOURCE_TYPES = [
  'daily-cleaning',
  'toilet-inspections',
  'public-area-inspections',
  'supervisor-inspections',
  'findings',
] as const;
export type HousekeepingEvidenceSourceType =
  (typeof HOUSEKEEPING_EVIDENCE_SOURCE_TYPES)[number];

export function isEvidenceType(value: unknown): value is EvidenceType {
  return (
    typeof value === 'string' &&
    (EVIDENCE_TYPES as readonly string[]).includes(value)
  );
}

export function isHousekeepingEvidenceSourceType(
  value: unknown,
): value is HousekeepingEvidenceSourceType {
  return (
    typeof value === 'string' &&
    (HOUSEKEEPING_EVIDENCE_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export type PublicHousekeepingEvidenceRequirement = {
  id: string;
  clientId: string;
  targetType: string;
  targetId: string;
  evidenceType: EvidenceType;
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicHousekeepingEvidenceSubmission = {
  id: string;
  clientId: string;
  evidenceRequirementId: string | null;
  executionType: string;
  executionId: string;
  evidenceType: EvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  submittedByUserId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type SubmitHousekeepingEvidenceInput = {
  sourceType: HousekeepingEvidenceSourceType;
  sourceId: string;
  evidenceType: EvidenceType;
  evidenceRequirementId?: string | null;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt?: string | null;
  submittedByUserId: string;
};

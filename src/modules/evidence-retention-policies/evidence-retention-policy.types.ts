/**
 * CR-BE-DOC-CONTROL-01 PART 03 — Evidence retention policy types.
 *
 * Client-owned, optionally Building-scoped retention configuration over the
 * EXISTING evidence vocabularies (no new taxonomy). Modeled on the
 * `sla_definitions` authority (START GOVERNANCE §5).
 */

export const EVIDENCE_RETENTION_POLICY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type EvidenceRetentionPolicyStatus =
  (typeof EVIDENCE_RETENTION_POLICY_STATUSES)[number];

/** Existing BE-07 evidence type vocabulary. */
export const RETENTION_EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;
export type RetentionEvidenceType = (typeof RETENTION_EVIDENCE_TYPES)[number];

/** The authoritative 0281 execution union of evidence_submissions. */
export const RETENTION_EXECUTION_TYPES = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'WORK_ORDER',
  'VENDOR_WORK',
  'UTILITY_METER_READING',
  'PERMIT',
  'FINDING',
  'FINDING_REWORK',
  'FINDING_VERIFICATION',
] as const;
export type RetentionExecutionType = (typeof RETENTION_EXECUTION_TYPES)[number];

export type EvidenceRetentionPolicyRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  code: string;
  name: string;
  evidenceType: RetentionEvidenceType | null;
  executionType: RetentionExecutionType | null;
  retentionDays: number;
  status: EvidenceRetentionPolicyStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicEvidenceRetentionPolicy = Omit<
  EvidenceRetentionPolicyRecord,
  'effectiveFrom' | 'effectiveTo' | 'createdAt' | 'updatedAt'
> & {
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateEvidenceRetentionPolicyInput = {
  clientId: string;
  buildingId?: string;
  code: string;
  name: string;
  evidenceType?: RetentionEvidenceType;
  executionType?: RetentionExecutionType;
  retentionDays: number;
  status?: EvidenceRetentionPolicyStatus;
  effectiveFrom: string;
  effectiveTo?: string;
};

export type UpdateEvidenceRetentionPolicyInput = {
  name?: string;
  evidenceType?: RetentionEvidenceType | null;
  executionType?: RetentionExecutionType | null;
  retentionDays?: number;
  status?: EvidenceRetentionPolicyStatus;
  effectiveFrom?: string;
  effectiveTo?: string | null;
};

export type EvidenceRetentionPolicyFilters = {
  buildingId?: string;
  status?: EvidenceRetentionPolicyStatus;
};

/** A candidate with its deterministic specificity score (§5). */
export type ApplicableRetentionPolicy = {
  id: string;
  code: string;
  retentionDays: number;
  specificity: number;
};

export const WORKFORCE_CERTIFICATION_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'INACTIVE',
] as const;

export type WorkforceCertificationStatus =
  (typeof WORKFORCE_CERTIFICATION_STATUSES)[number];

export const WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES = [
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
] as const;

export type WorkforceCertificationVerificationStatus =
  (typeof WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES)[number];

export const WORKFORCE_CERTIFICATION_EXPIRY_STATUSES = [
  'VALID',
  'EXPIRED',
  'NOT_APPLICABLE',
] as const;

export type WorkforceCertificationExpiryStatus =
  (typeof WORKFORCE_CERTIFICATION_EXPIRY_STATUSES)[number];

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 02 — the certification authority codes.
 *
 * Individual worker certifications are their own authority domain: they are
 * NOT skill assignments (BE-03D1/D2 `skill.*`), NOT workforce master data
 * (`workforce.*`) and NOT vendor licences (`vendor_licenses_certifications`).
 * A broad catalogue or tenant permission must therefore never be accepted as a
 * substitute — see `workforce-certification.service.ts`.
 *
 * `verify` is withheld from every role by default (foundation seed +
 * `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`): attesting a worker's competence is
 * a deliberate, audited administrative grant.
 */
export const WORKFORCE_CERTIFICATION_PERMISSIONS = {
  read: 'workforce_certification.read',
  manage: 'workforce_certification.manage',
  verify: 'workforce_certification.verify',
} as const;

export type WorkforceCertificationActor = {
  id: string;
  email?: string;
  displayName?: string | null;
  status?: string;
  sessionId?: string;
  permissions?: readonly string[];
};

export type WorkforceCertificationDocumentSummary = {
  id: string;
  documentNumber: string;
  documentType: string;
  title: string;
  fileReference: string;
  status: string;
};

export type WorkforceCertificationSkillSummary = {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
};

export type WorkforceCertificationRecord = {
  id: string;
  clientId: string;
  workforceProfileId: string;
  skillId: string | null;
  skill: WorkforceCertificationSkillSummary | null;
  certificateNumber: string;
  certificateName: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate: string | null;
  status: WorkforceCertificationStatus;
  expiryStatus: WorkforceCertificationExpiryStatus;
  /**
   * True when the expiry instant has passed. Never true for a certificate with
   * no expiry date (a lifelong certificate simply never expires).
   */
  isExpired: boolean;
  /**
   * True only when the certificate can actually satisfy a certification
   * requirement right now: ACTIVE, not past its expiry date, and VERIFIED.
   * An unverified, rejected, inactive or expired certificate is never "valid",
   * regardless of how recently it was issued.
   */
  isValid: boolean;
  verificationStatus: WorkforceCertificationVerificationStatus;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  documentId: string | null;
  fileReference: string | null;
  documentReference: WorkforceCertificationDocumentSummary | null;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * PART 02 — one row of the expiry-watch read model. Unlike the per-profile
 * list, the worker identity has to travel with the row because the caller is
 * looking across every workforce profile inside their own Client scope.
 */
export type WorkforceCertificationExpiringItem = {
  certification: WorkforceCertificationRecord;
  workforceProfile: {
    id: string;
    fullName: string;
    employeeCode: string;
    organizationId: string;
  };
  /** Whole days between "now" and `expiryDate` (never negative). */
  daysUntilExpiry: number;
};

/**
 * PART 02 — the projection wired into the Mobile worker profile
 * (`certificationsAndExpiry.individualCertifications`).
 *
 * Deliberately narrower than the operations DTO: it never carries a raw
 * storage key. "Document availability" is expressed as a boolean plus the
 * document id, so the storage path stays server-side and a future download
 * endpoint can enforce its own scope.
 */
export type WorkforceCertificationMobileSummary = {
  id: string;
  certificateNumber: string;
  certificateName: string;
  issuingAuthority: string;
  skillId: string | null;
  skillCode: string | null;
  skillName: string | null;
  status: WorkforceCertificationStatus;
  verificationStatus: WorkforceCertificationVerificationStatus;
  issueDate: string;
  expiryDate: string | null;
  expiryStatus: WorkforceCertificationExpiryStatus;
  isExpired: boolean;
  isValid: boolean;
  documentAvailable: boolean;
  documentId: string | null;
};

export type CreateWorkforceCertificationInput = {
  skillId?: string | null;
  certificateNumber: string;
  certificateName: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate?: string | null;
  status?: WorkforceCertificationStatus;
  documentId?: string | null;
  fileReference?: string | null;
  notes?: string | null;
};

export type UpdateWorkforceCertificationInput = {
  skillId?: string | null;
  certificateNumber?: string;
  certificateName?: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiryDate?: string | null;
  status?: WorkforceCertificationStatus;
  documentId?: string | null;
  fileReference?: string | null;
  notes?: string | null;
};

export type VerifyWorkforceCertificationInput = {
  verificationStatus: WorkforceCertificationVerificationStatus;
  notes?: string | null;
};

export type DeactivateWorkforceCertificationInput = {
  reason?: string | null;
};

export type ListWorkforceCertificationsFilter = {
  status?: WorkforceCertificationStatus;
  verificationStatus?: WorkforceCertificationVerificationStatus;
  skillId?: string;
  currentOnly?: boolean;
};

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B1 — one immutable row of the certification
 * decision ledger.
 *
 * `decision` is the resulting verification status. `previous*` describes the
 * decision this row replaced, which is exactly the information the single-row
 * PART 02 model used to overwrite. `changedFields` is populated only when a
 * MATERIAL metadata edit forced the reset, so a reader can tell an
 * administrative reset apart from an explicit verify/reject.
 */
export type CertificationDecisionRecord = {
  id: string;
  clientId: string;
  certificationId: string;
  workforceProfileId: string;
  decision: WorkforceCertificationVerificationStatus;
  previousVerificationStatus: WorkforceCertificationVerificationStatus | null;
  previousVerifiedByUserId: string | null;
  previousVerifiedAt: string | null;
  changedFields: string[] | null;
  /** The note supplied with a verify/reject decision (never the metadata edit). */
  reason: string | null;
  decidedByUserId: string | null;
  decidedAt: string;
};

/**
 * Fields whose change invalidates a previous attestation. Deliberately
 * MATERIAL only: a note or a bookkeeping edit must not silently withdraw an
 * attestation, but anything that changes WHAT was attested must.
 *
 * `expiryDate` and `status` are on the list because extending validity changes
 * the claim being made. `notes` is intentionally absent.
 */
export const CERTIFICATION_MATERIAL_FIELDS = [
  'certificateNumber',
  'certificateName',
  'issuingAuthority',
  'issueDate',
  'expiryDate',
  'skillId',
  'documentId',
  'fileReference',
  'status',
] as const;

export type CertificationMaterialField =
  (typeof CERTIFICATION_MATERIAL_FIELDS)[number];

export type ListExpiringWorkforceCertificationsFilter = {
  /** Look-ahead window in days. Defaults to 30, bounded to 1..365. */
  days: number;
  workforceProfileId?: string;
  verificationStatus?: WorkforceCertificationVerificationStatus;
};

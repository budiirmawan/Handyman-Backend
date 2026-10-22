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

export type CreateWorkforceCertificationInput = {
  skillId?: string | null;
  certificateNumber: string;
  certificateName: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate?: string | null;
  status?: WorkforceCertificationStatus;
  verificationStatus?: WorkforceCertificationVerificationStatus;
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
  verificationStatus?: WorkforceCertificationVerificationStatus;
  documentId?: string | null;
  fileReference?: string | null;
  notes?: string | null;
};

export type VerifyWorkforceCertificationInput = {
  verificationStatus: WorkforceCertificationVerificationStatus;
  notes?: string | null;
};

export type ListWorkforceCertificationsFilter = {
  status?: WorkforceCertificationStatus;
  verificationStatus?: WorkforceCertificationVerificationStatus;
  skillId?: string;
  currentOnly?: boolean;
};

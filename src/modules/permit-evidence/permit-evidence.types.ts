import type { PermitContractorContextType } from '../permits/permit.types';

export const PERMIT_EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;
export type PermitEvidenceType = (typeof PERMIT_EVIDENCE_TYPES)[number];
export function isPermitEvidenceType(value: unknown): value is PermitEvidenceType {
  return typeof value === 'string' &&
    (PERMIT_EVIDENCE_TYPES as readonly string[]).includes(value);
}

export type PermitEvidenceContextAssertion = {
  buildingId: string;
  contractorContextType: PermitContractorContextType;
  contractorContextId: string;
};

export type CreatePermitEvidenceRequirementInput =
  PermitEvidenceContextAssertion & {
    evidenceType: PermitEvidenceType;
    required: boolean;
    minimumCount: number;
    maximumCount: number | null;
    description?: string | null;
  };

export type PublicPermitEvidenceRequirement = {
  id: string;
  clientId: string;
  permitId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: PermitContractorContextType;
  contractorVendorId: string;
  evidenceType: PermitEvidenceType;
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type SubmitPermitEvidenceInput = PermitEvidenceContextAssertion & {
  evidenceRequirementId: string;
  evidenceType: PermitEvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt?: Date | null;
};

export type PublicPermitEvidence = {
  id: string;
  clientId: string;
  permitId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: PermitContractorContextType;
  contractorVendorId: string;
  evidenceRequirementId: string | null;
  evidenceType: PermitEvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  submittedByUserId: string | null;
  submittedAt: string;
  status: 'ACTIVE' | 'REMOVED';
  createdAt: string;
  updatedAt: string;
};

export type PermitEvidenceFilters = {
  permitId?: string;
  buildingId?: string;
  contractorVendorId?: string;
  evidenceType?: PermitEvidenceType;
  status?: 'ACTIVE' | 'REMOVED';
};

export type PermitEvidenceReadinessDetail = {
  evidenceRequirementId: string;
  evidenceType: PermitEvidenceType;
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  activeCount: number;
  satisfied: boolean;
};

export type PermitEvidenceReadiness = {
  permitId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: PermitContractorContextType;
  contractorVendorId: string;
  configured: boolean;
  ready: boolean;
  missingEvidenceTypes: PermitEvidenceType[];
  requirements: PermitEvidenceReadinessDetail[];
};

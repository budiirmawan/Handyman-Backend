import type {
  PermitContractorContextType,
  PermitStatus,
} from '../permits/permit.types';

export const PERMIT_APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'CANCELLED',
] as const;

export type PermitApplicationStatus =
  (typeof PERMIT_APPLICATION_STATUSES)[number];

export function isPermitApplicationStatus(
  value: unknown,
): value is PermitApplicationStatus {
  return typeof value === 'string' &&
    (PERMIT_APPLICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Application data plus its authoritative BE-20A Permit projection. Permit,
 * applicant, Contractor, Client, Building, and work-description fields are
 * selected through the Permit reference and are not copied into the
 * permit_applications table.
 */
export type PermitApplicationRecord = {
  id: string;
  permitId: string;
  permitReference: string;
  permitStatus: PermitStatus;
  clientId: string;
  buildingId: string;
  applicantReference: string | null;
  contractorContextType: PermitContractorContextType;
  contractorContextId: string;
  contractorVendorId: string;
  tenantContractorRelationshipId: string | null;
  workDescription: string;
  requestedWorkAt: Date;
  status: PermitApplicationStatus;
  submittedAt: Date | null;
  submittedByUserId: string | null;
  notes: string | null;
  createdByUserId: string;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitApplication = Omit<
  PermitApplicationRecord,
  | 'requestedWorkAt'
  | 'submittedAt'
  | 'cancelledAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  requestedWorkAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePermitApplicationInput = {
  permitId: string;
  requestedWorkAt: Date;
  notes?: string | null;
  /** Optional client assertions; values are validated against, never copied from, the Permit. */
  applicantReference?: string | null;
  contractorContextType?: PermitContractorContextType;
  contractorContextId?: string;
  workDescription?: string;
};

export type NewPermitApplication = {
  permitId: string;
  requestedWorkAt: Date;
  notes: string | null;
  createdByUserId: string;
};

export type UpdatePermitApplicationInput = {
  requestedWorkAt?: Date;
  notes?: string | null;
};

export type PermitApplicationFilters = {
  buildingId?: string;
  contractorVendorId?: string;
  contractorContextId?: string;
  status?: PermitApplicationStatus;
  requestedWorkFrom?: Date;
  requestedWorkTo?: Date;
  requestedWorkDate?: string;
};

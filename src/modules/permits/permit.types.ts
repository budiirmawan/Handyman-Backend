import type { PermitValidityStatus } from '../permit-validities/permit-validity.types';
import type { PermitWorkLocationType } from '../permit-work-contexts/permit-work-context.types';

/**
 * BE-20A — shared Permit to Work foundation types.
 *
 * A Permit always resolves to one BE-06 Vendor contractor. Tenant-sponsored
 * contractors retain the BE-14I Tenant Contractor relationship as their
 * context; directly engaged Vendor contractors use the Vendor itself as the
 * context. Both use this same Permit record and lifecycle.
 */
export const PERMIT_CONTRACTOR_CONTEXT_TYPES = [
  'VENDOR_CONTRACTOR',
  'TENANT_CONTRACTOR',
] as const;

export type PermitContractorContextType =
  (typeof PERMIT_CONTRACTOR_CONTEXT_TYPES)[number];

export function isPermitContractorContextType(
  value: unknown,
): value is PermitContractorContextType {
  return typeof value === 'string' &&
    (PERMIT_CONTRACTOR_CONTEXT_TYPES as readonly string[]).includes(value);
}

/** BE-20A intentionally exposes only the minimal foundation lifecycle. */
export const PERMIT_STATUSES = ['DRAFT', 'CANCELLED'] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];

export function isPermitStatus(value: unknown): value is PermitStatus {
  return typeof value === 'string' &&
    (PERMIT_STATUSES as readonly string[]).includes(value);
}

export type PermitRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  permitNumber: string;
  permitType: string;
  title: string;
  workDescription: string;
  applicantReference: string | null;
  contractorContextType: PermitContractorContextType;
  contractorVendorId: string;
  tenantContractorRelationshipId: string | null;
  status: PermitStatus;
  requestedAt: Date;
  createdByUserId: string;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermit = Omit<
  PermitRecord,
  'requestedAt' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  /** The source-specific context id supplied when the Permit was created. */
  contractorContextId: string;
  requestedAt: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePermitInput = {
  buildingId: string;
  permitNumber: string;
  permitType: string;
  title: string;
  workDescription: string;
  applicantReference?: string | null;
  contractorContextType: PermitContractorContextType;
  /** Vendor id for VENDOR_CONTRACTOR; BE-14I relationship id for TENANT_CONTRACTOR. */
  contractorContextId: string;
};

export type NewPermit = Omit<
  PermitRecord,
  | 'id'
  | 'status'
  | 'requestedAt'
  | 'cancelledAt'
  | 'cancelledByUserId'
  | 'createdAt'
  | 'updatedAt'
>;

export type UpdatePermitInput = {
  permitType?: string;
  title?: string;
  workDescription?: string;
  applicantReference?: string | null;
};

export type PermitFilters = {
  buildingId?: string;
  contractorVendorId?: string;
  contractorContextId?: string;
  status?: PermitStatus;
  permitType?: string;
  /** BE-20D work-context filters. */
  locationType?: PermitWorkLocationType;
  locationId?: string;
  workType?: string;
  /** BE-20G current-validity filters. */
  validityStatus?: PermitValidityStatus;
  validAt?: Date;
};

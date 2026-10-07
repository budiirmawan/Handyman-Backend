import type { PermitContractorContextType } from '../permits/permit.types';

/**
 * BE-20B — one operational Contractor context projected from existing masters.
 * No Contractor identity is persisted here: Vendor identity comes from BE-06,
 * while Tenant sponsorship comes from the existing BE-14I relationship.
 */
export type ContractorContextRecord = {
  contractorContextType: PermitContractorContextType;
  contractorContextId: string;
  clientId: string;
  buildingId: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  vendorBuildingRelationshipId: string;
  tenantCompanyId: string | null;
  tenantCode: string | null;
  tenantName: string | null;
  tenantContractorRelationshipId: string | null;
  spaceId: string | null;
  relationshipType: string | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: 'ACTIVE';
};

export type PublicContractorContext = Omit<
  ContractorContextRecord,
  'effectiveFrom' | 'effectiveUntil'
> & {
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  eligibleForPermit: true;
};

export type ResolveContractorContextInput = {
  contractorContextType: PermitContractorContextType;
  /** Vendor id for VENDOR_CONTRACTOR; BE-14I relationship id for TENANT_CONTRACTOR. */
  contractorContextId: string;
  /** Required for Vendor contexts; Tenant contexts are already Building-bound. */
  buildingId?: string;
};

export type ContractorContextFilters = {
  contractorContextType?: PermitContractorContextType;
  tenantCompanyId?: string;
  vendorId?: string;
  buildingId?: string;
};

export type ContractorPermitEligibility = {
  eligible: true;
  contractorContext: PublicContractorContext;
};

export const TENANT_CONTRACTOR_RELATIONSHIP_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type TenantContractorRelationshipStatus =
  (typeof TENANT_CONTRACTOR_RELATIONSHIP_STATUSES)[number];
export const isTenantContractorRelationshipStatus = (
  value: unknown,
): value is TenantContractorRelationshipStatus =>
  typeof value === 'string' &&
  (TENANT_CONTRACTOR_RELATIONSHIP_STATUSES as readonly string[]).includes(value);

export type TenantContractorRelationshipRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  contractorVendorId: string;
  buildingId: string;
  spaceId: string | null;
  relationshipType: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: TenantContractorRelationshipStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantContractorRelationship = Omit<
  TenantContractorRelationshipRecord,
  'effectiveFrom' | 'effectiveUntil' | 'createdAt' | 'updatedAt'
> & {
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantContractorRelationshipInput = {
  tenantCompanyId: string;
  contractorVendorId: string;
  buildingId: string;
  spaceId?: string;
  relationshipType: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: TenantContractorRelationshipStatus;
  notes?: string;
};

export type NewTenantContractorRelationship = {
  clientId: string;
  tenantCompanyId: string;
  contractorVendorId: string;
  buildingId: string;
  spaceId: string | null;
  relationshipType: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: TenantContractorRelationshipStatus;
  notes: string | null;
};

export type UpdateTenantContractorRelationshipInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: TenantContractorRelationshipStatus;
  notes?: string | null;
};

export type TenantContractorRelationshipFilters = {
  tenantCompanyId?: string;
  buildingId?: string;
  contractorVendorId?: string;
  relationshipType?: string;
  status?: TenantContractorRelationshipStatus;
};

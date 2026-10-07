/** BE-14C — Tenant Company relationship to an existing Building Space. */
export const TENANT_SPACE_RELATIONSHIP_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type TenantSpaceRelationshipStatus =
  (typeof TENANT_SPACE_RELATIONSHIP_STATUSES)[number];

export function isTenantSpaceRelationshipStatus(
  value: unknown,
): value is TenantSpaceRelationshipStatus {
  return typeof value === 'string' &&
    (TENANT_SPACE_RELATIONSHIP_STATUSES as readonly string[]).includes(value);
}

export type TenantSpaceRelationshipRecord = {
  id: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: TenantSpaceRelationshipStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantSpaceRelationship = {
  id: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: TenantSpaceRelationshipStatus;
  createdAt: string;
  updatedAt: string;
};

export type AssignTenantSpaceInput = {
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: TenantSpaceRelationshipStatus;
};

export type NewTenantSpaceRelationship = {
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: TenantSpaceRelationshipStatus;
};

export type UpdateTenantSpaceRelationshipInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: TenantSpaceRelationshipStatus;
};

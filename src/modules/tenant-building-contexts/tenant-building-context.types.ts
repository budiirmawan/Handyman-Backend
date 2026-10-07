/** BE-14D — Tenant Company operational context in an existing Building. */
export const TENANT_BUILDING_CONTEXT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type TenantBuildingContextStatus =
  (typeof TENANT_BUILDING_CONTEXT_STATUSES)[number];

export function isTenantBuildingContextStatus(
  value: unknown,
): value is TenantBuildingContextStatus {
  return typeof value === 'string' &&
    (TENANT_BUILDING_CONTEXT_STATUSES as readonly string[]).includes(value);
}

export type TenantBuildingContextRecord = {
  id: string;
  tenantCompanyId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: TenantBuildingContextStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantBuildingContext = {
  id: string;
  tenantCompanyId: string;
  buildingId: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: TenantBuildingContextStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantBuildingContextInput = {
  tenantCompanyId: string;
  buildingId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: TenantBuildingContextStatus;
};

export type NewTenantBuildingContext = {
  tenantCompanyId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: TenantBuildingContextStatus;
};

export type UpdateTenantBuildingContextInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: TenantBuildingContextStatus;
};

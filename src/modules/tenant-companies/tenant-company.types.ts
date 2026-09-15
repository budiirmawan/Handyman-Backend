/** BE-14A — Client-scoped Tenant Company master data. */
export const TENANT_COMPANY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type TenantCompanyStatus = (typeof TENANT_COMPANY_STATUSES)[number];

export function isTenantCompanyStatus(value: unknown): value is TenantCompanyStatus {
  return typeof value === 'string' &&
    (TENANT_COMPANY_STATUSES as readonly string[]).includes(value);
}

export type TenantCompanyRecord = {
  id: string;
  clientId: string;
  tenantCode: string;
  tenantName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: TenantCompanyStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantCompany = Omit<TenantCompanyRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantCompanyInput = {
  clientId: string;
  tenantCode: string;
  tenantName: string;
  legalName?: string;
  email?: string;
  phone?: string;
  address?: string;
  status?: TenantCompanyStatus;
};

export type UpdateTenantCompanyInput = {
  tenantName?: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: TenantCompanyStatus;
};

export type TenantCompanyListFilters = {
  search?: string;
  status?: TenantCompanyStatus;
};

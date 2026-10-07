/** BE-14B — Tenant Company contact with optional existing User binding. */
export const TENANT_PIC_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type TenantPicStatus = (typeof TENANT_PIC_STATUSES)[number];

export function isTenantPicStatus(value: unknown): value is TenantPicStatus {
  return typeof value === 'string' &&
    (TENANT_PIC_STATUSES as readonly string[]).includes(value);
}

export type TenantPicRecord = {
  id: string;
  tenantCompanyId: string;
  userId: string | null;
  picName: string;
  email: string | null;
  phone: string | null;
  roleTitle: string | null;
  isPrimary: boolean;
  status: TenantPicStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantPic = Omit<TenantPicRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantPicInput = {
  tenantCompanyId: string;
  userId?: string;
  picName: string;
  email?: string;
  phone?: string;
  roleTitle?: string;
  isPrimary?: boolean;
  status?: TenantPicStatus;
};

export type NewTenantPic = {
  tenantCompanyId: string;
  userId: string | null;
  picName: string;
  email: string | null;
  phone: string | null;
  roleTitle: string | null;
  isPrimary: boolean;
  status: TenantPicStatus;
};

export type UpdateTenantPicInput = {
  userId?: string | null;
  picName?: string;
  email?: string | null;
  phone?: string | null;
  roleTitle?: string | null;
  isPrimary?: boolean;
  status?: TenantPicStatus;
};

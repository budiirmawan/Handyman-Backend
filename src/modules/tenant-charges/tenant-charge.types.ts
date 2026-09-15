export const TENANT_CHARGE_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type TenantChargeStatus = (typeof TENANT_CHARGE_STATUSES)[number];
export const isTenantChargeStatus = (value: unknown): value is TenantChargeStatus =>
  typeof value === 'string' &&
  (TENANT_CHARGE_STATUSES as readonly string[]).includes(value);

export type TenantChargeRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  chargeType: string;
  description: string;
  amount: string;
  /** NULL remains UNKNOWN for legacy rows; new/changed monetary charges are governed. */
  currencyCode: string | null;
  chargeDate: string;
  dueDate: string | null;
  status: TenantChargeStatus;
  reference: string | null;
  notes: string | null;
  createdByUserId: string;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantCharge = Omit<
  TenantChargeRecord,
  'amount' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  amount: number;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantChargeInput = {
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  chargeType: string;
  description: string;
  amount: number;
  currencyCode: string;
  chargeDate: string;
  dueDate?: string | null;
  reference?: string;
  notes?: string;
};

export type NewTenantCharge = Omit<CreateTenantChargeInput, 'dueDate' | 'reference' | 'notes'> & {
  clientId: string;
  dueDate: string | null;
  reference: string | null;
  notes: string | null;
  createdByUserId: string;
};

export type UpdateTenantChargeInput = {
  chargeType?: string;
  description?: string;
  amount?: number;
  currencyCode?: string;
  chargeDate?: string;
  dueDate?: string | null;
  reference?: string | null;
  notes?: string | null;
};

export type TenantChargeFilters = {
  tenantCompanyId?: string;
  buildingId?: string;
  spaceId?: string;
  chargeType?: string;
  status?: TenantChargeStatus;
  chargeDateFrom?: string;
  chargeDateTo?: string;
};

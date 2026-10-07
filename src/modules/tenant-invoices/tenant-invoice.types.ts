export const TENANT_INVOICE_STATUSES = ['DRAFT', 'FINALIZED', 'CANCELLED'] as const;
export type TenantInvoiceStatus = (typeof TENANT_INVOICE_STATUSES)[number];
export const isTenantInvoiceStatus = (value: unknown): value is TenantInvoiceStatus =>
  typeof value === 'string' && (TENANT_INVOICE_STATUSES as readonly string[]).includes(value);

export const TENANT_INVOICE_SOURCE_TYPES = ['TENANT_CHARGE', 'UTILITY_BILL'] as const;
export type TenantInvoiceSourceType = (typeof TENANT_INVOICE_SOURCE_TYPES)[number];
export const isTenantInvoiceSourceType = (value: unknown): value is TenantInvoiceSourceType =>
  typeof value === 'string' && (TENANT_INVOICE_SOURCE_TYPES as readonly string[]).includes(value);

export type TenantInvoiceRecord = {
  id: string; clientId: string; tenantCompanyId: string; buildingId: string;
  spaceId: string; invoiceNumber: string; invoiceDate: string; dueDate: string;
  status: TenantInvoiceStatus; subtotal: string; totalAmount: string;
  /** One exact header currency; NULL remains UNKNOWN for legacy drafts. */
  currencyCode: string | null;
  notes: string | null; createdByUserId: string; finalizedAt: Date | null;
  finalizedByUserId: string | null; cancelledAt: Date | null;
  cancelledByUserId: string | null; createdAt: Date; updatedAt: Date;
};
export type TenantInvoiceLineRecord = {
  id: string; invoiceId: string; sourceType: TenantInvoiceSourceType;
  tenantChargeId: string | null; utilityBillId: string | null;
  amountSnapshot: string; currencyCode: string | null; createdAt: Date;
};
export type PublicTenantInvoiceLine = Omit<TenantInvoiceLineRecord, 'amountSnapshot' | 'createdAt'> & {
  sourceId: string; amount: number; createdAt: string;
};
export type PublicTenantInvoice = Omit<
  TenantInvoiceRecord,
  'subtotal' | 'totalAmount' | 'finalizedAt' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  subtotal: number; totalAmount: number; finalizedAt: string | null;
  cancelledAt: string | null; createdAt: string; updatedAt: string;
  lines: PublicTenantInvoiceLine[];
};
export type CreateTenantInvoiceInput = {
  tenantCompanyId: string; buildingId: string; spaceId: string;
  invoiceNumber: string; invoiceDate: string; dueDate: string;
  currencyCode: string; notes?: string;
};
export type NewTenantInvoice = Omit<CreateTenantInvoiceInput, 'notes'> & {
  clientId: string; notes: string | null; createdByUserId: string;
};
export type AddTenantInvoiceLineInput = {
  sourceType: TenantInvoiceSourceType; sourceId: string;
};
export type NewTenantInvoiceLine = {
  invoiceId: string; sourceType: TenantInvoiceSourceType;
  tenantChargeId: string | null; utilityBillId: string | null; amountSnapshot: string;
  currencyCode: string;
};
export type UpdateTenantInvoiceInput = {
  invoiceDate?: string; dueDate?: string; notes?: string | null;
  currencyCode?: string;
};
export type TenantInvoiceFilters = {
  tenantCompanyId?: string; buildingId?: string; status?: TenantInvoiceStatus;
  invoiceDateFrom?: string; invoiceDateTo?: string;
};

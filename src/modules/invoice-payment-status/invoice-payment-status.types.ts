import type { TenantInvoiceStatus } from '../tenant-invoices';

export const INVOICE_PAYMENT_STATUSES = [
  'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED',
] as const;
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number];
export const isInvoicePaymentStatus = (value: unknown): value is InvoicePaymentStatus =>
  typeof value === 'string' && (INVOICE_PAYMENT_STATUSES as readonly string[]).includes(value);

export type InvoicePaymentStatusRecord = {
  id: string; invoiceId: string; clientId: string; tenantCompanyId: string;
  buildingId: string; paymentStatus: InvoicePaymentStatus; paidAmount: string;
  outstandingAmount: string; paidAt: Date | null; paymentReference: string | null;
  notes: string | null; recordedByUserId: string; createdAt: Date; updatedAt: Date;
  invoiceTotal: string; invoiceDueDate: string; invoiceStatus: TenantInvoiceStatus;
};
export type PublicInvoicePaymentStatus = Omit<
  InvoicePaymentStatusRecord,
  'paidAmount' | 'outstandingAmount' | 'paidAt' | 'createdAt' | 'updatedAt' |
  'invoiceTotal' | 'invoiceDueDate' | 'invoiceStatus'
> & {
  paidAmount: number; outstandingAmount: number; paidAt: string | null;
  createdAt: string; updatedAt: string;
};
export type RecordInvoicePaymentStatusInput = {
  invoiceId: string; paidAmount: number; paidAt?: Date | null;
  paymentReference?: string | null; notes?: string | null;
};
export type NewInvoicePaymentStatus = {
  invoiceId: string; clientId: string; tenantCompanyId: string; buildingId: string;
  paymentStatus: InvoicePaymentStatus; paidAmount: number; outstandingAmount: number;
  paidAt: Date | null; paymentReference: string | null; notes: string | null;
  recordedByUserId: string;
};
export type UpdateInvoicePaymentStatusInput = {
  paidAmount?: number; paidAt?: Date | null;
  paymentReference?: string | null; notes?: string | null;
};
export type InvoicePaymentStatusFilters = {
  tenantCompanyId?: string; buildingId?: string; status?: InvoicePaymentStatus;
};

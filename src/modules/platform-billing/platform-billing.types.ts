/**
 * CR-BE-SAAS-01 PART 06 — SaaS Billing Account & Invoice types.
 *
 * Frozen contract §14. Product-agnostic: no product-specific fields —
 * the commercial chain stays Customer → Subscription → Product, and any
 * future Gatepro product profile bills through these same aggregates.
 */

// ---------------------------------------------------------------------------
// Billing account (frozen §14.1)
// ---------------------------------------------------------------------------

export const SAAS_BILLING_ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SaasBillingAccountStatus =
  (typeof SAAS_BILLING_ACCOUNT_STATUSES)[number];

export type SaasBillingAccountRecord = {
  id: string;
  customerId: string;
  legalName: string;
  taxIdentity: string | null;
  billingAddress: Record<string, unknown>;
  billingEmail: string | null;
  currencyCode: string;
  paymentTerms: number;
  status: SaasBillingAccountStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSaasBillingAccount = {
  id: string;
  customerId: string;
  legalName: string;
  taxIdentity: string | null;
  billingAddress: Record<string, unknown>;
  billingEmail: string | null;
  currencyCode: string;
  paymentTerms: number;
  status: SaasBillingAccountStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateSaasBillingAccountInput = {
  customerId: string;
  legalName: string;
  taxIdentity?: string;
  billingAddress?: Record<string, unknown>;
  billingEmail?: string;
  currencyCode: string;
  /** Days; default 30 (frozen §14.1). */
  paymentTerms?: number;
};

export type UpdateSaasBillingAccountInput = {
  legalName?: string;
  /** Explicit null clears the field. */
  taxIdentity?: string | null;
  billingAddress?: Record<string, unknown>;
  /** Explicit null clears the field. */
  billingEmail?: string | null;
  currencyCode?: string;
  paymentTerms?: number;
  status?: SaasBillingAccountStatus;
  /** Frozen §17.3 — the route is "ver". */
  expectedVersion: number;
};

// ---------------------------------------------------------------------------
// Invoice (frozen §14.2)
// ---------------------------------------------------------------------------

/**
 * Frozen §14.4 vocabulary (full set stored). PART 06 implements the
 * DRAFT→ISSUED and DRAFT/ISSUED→VOID commands only; PARTIALLY_PAID / PAID
 * (PART 07 reconciliation) and OVERDUE (PART 08 §11.4 sweep) transitions
 * are deliberately not implemented.
 */
export const SAAS_INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'VOID',
] as const;
export type SaasInvoiceStatus = (typeof SAAS_INVOICE_STATUSES)[number];

/**
 * Frozen §14.3 vocabulary (full set stored). PART 06 only GENERATES the
 * types backed by implemented authority: BASE_SUBSCRIPTION and
 * ADDITIONAL_BUILDING. ADD_ON / USAGE / DISCOUNT / ADJUSTMENT / TAX exist
 * as vocabulary for future PARTs (add-ons, PART 09 metering, adjustments,
 * tax).
 */
export const SAAS_INVOICE_LINE_TYPES = [
  'BASE_SUBSCRIPTION',
  'ADDITIONAL_BUILDING',
  'ADD_ON',
  'USAGE',
  'DISCOUNT',
  'ADJUSTMENT',
  'TAX',
] as const;
export type SaasInvoiceLineType = (typeof SAAS_INVOICE_LINE_TYPES)[number];

/** Provenance of a line (frozen §14.3 reference_type/reference_id). */
export type SaasInvoiceLineReferenceType = 'SUBSCRIPTION' | 'ADD_ON' | 'USAGE_AGGREGATION';

export type SaasInvoiceLineRecord = {
  id: string;
  invoiceId: string;
  lineType: SaasInvoiceLineType;
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  currencyCode: string;
  referenceType: SaasInvoiceLineReferenceType | null;
  referenceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SaasInvoiceRecord = {
  id: string;
  number: string;
  billingAccountId: string;
  customerId: string;
  subscriptionId: string | null;
  periodStart: Date;
  periodEnd: Date;
  currencyCode: string;
  baseAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: SaasInvoiceStatus;
  issuedAt: Date | null;
  dueAt: Date | null;
  /** PART 07 (Payment & Reconciliation) sets this — NULL in PART 06. */
  paidAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSaasInvoiceLine = {
  id: string;
  lineType: SaasInvoiceLineType;
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  currencyCode: string;
  referenceType: SaasInvoiceLineReferenceType | null;
  referenceId: string | null;
};

export type PublicSaasInvoice = {
  id: string;
  number: string;
  billingAccountId: string;
  customerId: string;
  subscriptionId: string | null;
  periodStart: string;
  periodEnd: string;
  currencyCode: string;
  baseAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: SaasInvoiceStatus;
  issuedAt: string | null;
  dueAt: string | null;
  /** Exposed for completeness; always null in PART 06 (no payment exists). */
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** GET /platform/invoices/:id — with lines (frozen §22). */
export type PublicSaasInvoiceDetail = PublicSaasInvoice & {
  lines: PublicSaasInvoiceLine[];
};

export type ListSaasInvoiceFilters = {
  customerId?: string;
  status?: SaasInvoiceStatus;
  /** Period-overlap window (ISO timestamps). */
  periodStart?: string;
  periodEnd?: string;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * POST /platform/invoices (frozen §22: "DRAFT (or draft+issue)").
 * The commercial source is the SUBSCRIPTION — no caller-supplied prices,
 * currency, or totals (frozen §10.4 / user-prompt commercial-source rule).
 */
export type CreateSaasInvoiceInput = {
  /** The authoritative PART 03 subscription (commercial source of truth). */
  subscriptionId: string;
  /** Defaults to the subscription's current period when present. */
  periodStart?: string;
  periodEnd?: string;
  /** Frozen §22 "draft+issue" variant — issue in the same command. */
  issue?: boolean;
};

export type IssueSaasInvoiceInput = {
  /** Frozen §17.3 — the route is "ver". */
  expectedVersion: number;
};

export type VoidSaasInvoiceInput = {
  /** Frozen §17.3 — the route is "ver". */
  expectedVersion: number;
  /** Mandatory (frozen §22/§18.3). */
  reason: string;
};

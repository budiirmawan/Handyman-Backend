/**
 * CR-BE-SAAS-01 PART 07 — Payment & Reconciliation types (frozen §15).
 *
 * Money is always represented as NUMERIC(18,2) on the wire. JSON cannot
 * safely carry NUMERIC; we serialize as **strings** (the canonical idem-
 * potent decimal representation). All arithmetic happens server-side via
 * pg's NUMERIC type — no JavaScript float arithmetic touches money.
 */

export const SAAS_PAYMENT_RECORD_STATUSES = [
  'PENDING',
  'RECONCILED',
  'REJECTED',
] as const;
export type SaasPaymentRecordStatus =
  (typeof SAAS_PAYMENT_RECORD_STATUSES)[number];

export const SAAS_PAYMENT_PROVIDER_TYPES = [
  'MANUAL_TRANSFER',
  'VIRTUAL_ACCOUNT',
  'QRIS',
  'CARD',
  'PAYMENT_GATEWAY',
  'OTHER',
] as const;
export type SaasPaymentProviderType =
  (typeof SAAS_PAYMENT_PROVIDER_TYPES)[number];

export type SaasPaymentRecordRow = {
  id: string;
  billingAccountId: string;
  customerId: string;
  providerType: SaasPaymentProviderType;
  providerName: string | null;
  providerReference: string | null;
  amount: string;
  currencyCode: string;
  receivedAt: Date;
  status: SaasPaymentRecordStatus;
  rejectionReason: string | null;
  reconciledByUserId: string | null;
  reconciledAt: Date | null;
  externalReference: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSaasPaymentRecord = {
  id: string;
  billingAccountId: string;
  customerId: string;
  providerType: SaasPaymentProviderType;
  providerName: string | null;
  providerReference: string | null;
  amount: string;
  currencyCode: string;
  receivedAt: string;
  status: SaasPaymentRecordStatus;
  rejectionReason: string | null;
  reconciledByUserId: string | null;
  reconciledAt: string | null;
  externalReference: string | null;
  version: number;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocations: PublicSaasPaymentAllocation[];
  createdAt: string;
  updatedAt: string;
};

export type SaasPaymentAllocationRow = {
  id: string;
  paymentId: string;
  invoiceId: string;
  customerId: string;
  billingAccountId: string;
  amount: string;
  currencyCode: string;
  createdAt: Date;
  createdByUserId: string | null;
};

export type PublicSaasPaymentAllocation = {
  id: string;
  paymentId: string;
  invoiceId: string;
  amount: string;
  currencyCode: string;
  createdAt: string;
};

/** Frozen §15.1 + §22 ingestion command (provider-neutral). */
export type IngestSaasPaymentInput = {
  billingAccountId: string;
  customerId: string;
  providerType: SaasPaymentProviderType;
  providerName?: string | null;
  providerReference?: string | null;
  /** Amount as a decimal string to preserve NUMERIC(18,2) precision. */
  amount: string;
  currencyCode: string;
  /** ISO 8601 timestamp — frozen; default = received_at. */
  receivedAt?: string;
  externalReference?: string | null;
  expectedVersion: number;
  reason?: string | null;
};

/** Frozen §15.4 + §22 reconcile command. */
export type ReconcileAllocationInput = {
  invoiceId: string;
  amount: string;
  expectedVersion: number;
};

export type ReconcileSaasPaymentInput = {
  allocations: ReconcileAllocationInput[];
  reason?: string | null;
  expectedVersion: number;
};

export type RejectSaasPaymentInput = {
  rejectionReason: string;
  expectedVersion: number;
};

export type ListSaasPaymentsParams = {
  customerId?: string;
  status?: SaasPaymentRecordStatus;
  billingAccountId?: string;
};

/**
 * CR-BE-COM-02 PART 01 + PART 02 — Vendor Invoice domain types.
 *
 * A Vendor Invoice is the canonical payable invoice from an external Vendor.
 * It is NOT a Tenant Invoice (receivable), NOT a vendor-service-cost
 * (operational costing), NOT a Purchase Order, and NOT a payment.
 *
 * Lifecycle: DRAFT → FINALIZED → CANCELLED.
 * DRAFT may be edited; FINALIZED is immutable; CANCELLED is terminal.
 *
 * Verification (PART 02): PENDING → VERIFIED / DISCREPANCY.
 * Only a FINALIZED invoice may be verified. Verification is idempotent
 * for VERIFIED; re-verification after DISCREPANCY is allowed.
 *
 * Stable references to existing operational context (all optional):
 *   - Vendor Work (BE-15B)
 *   - Work Order (BE-08)
 *   - Completion Report (BE-15F)
 *   - Service Report (BE-15G)
 *   - canonical BAST (BE-22C)
 *
 * Payment status and readiness below reuse this invoice as authority. There is
 * still no tax, GL, banking, gateway, or parallel AP/settlement engine.
 */
export const VENDOR_INVOICE_STATUSES = [
  'DRAFT',
  'FINALIZED',
  'CANCELLED',
] as const;

export type VendorInvoiceStatus = (typeof VENDOR_INVOICE_STATUSES)[number];

export function isVendorInvoiceStatus(
  value: unknown,
): value is VendorInvoiceStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_INVOICE_STATUSES as readonly string[]).includes(value)
  );
}

/** Supported ISO 4217 currency codes (extensible). */
export const VENDOR_INVOICE_CURRENCIES = [
  'IDR',
  'USD',
  'SGD',
  'MYR',
  'AUD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
] as const;

export type VendorInvoiceCurrency = (typeof VENDOR_INVOICE_CURRENCIES)[number];

export function isVendorInvoiceCurrency(
  value: unknown,
): value is VendorInvoiceCurrency {
  return (
    typeof value === 'string' &&
    (VENDOR_INVOICE_CURRENCIES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorInvoiceRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  receivedDate: string;
  currency: VendorInvoiceCurrency;
  invoiceAmount: string;
  status: VendorInvoiceStatus;
  /** Vendor's own reference / external number. */
  vendorReference: string | null;
  /** Optional stable reference to Vendor Work (BE-15B). */
  vendorWorkId: string | null;
  /** Optional stable reference to Work Order (BE-08). */
  workOrderId: string | null;
  /** Optional stable reference to Completion Report (BE-15F). */
  completionReportId: string | null;
  /** Optional stable reference to Service Report (BE-15G). */
  serviceReportId: string | null;
  /** Optional stable reference to canonical BAST (BE-22C). */
  bastDocumentId: string | null;
  /**
   * CR-BE-R2P-01 PART 06 — the ISSUED Purchase Order being invoiced against,
   * and the SPK under which the work was executed. Derived/validated from the
   * authoritative PO/SPK chain; never a second commercial authority.
   */
  purchaseOrderId: string | null;
  workContractId: string | null;
  notes: string | null;
  createdByUserId: string;
  /** PART 02: Verification status (PENDING / VERIFIED / DISCREPANCY). */
  verificationStatus: VendorInvoiceVerificationStatus;
  /** PART 02: Who verified. */
  verifiedByUserId: string | null;
  /** PART 02: When verified. */
  verifiedAt: Date | null;
  /** PART 02: Verifier's notes. */
  verificationNotes: string | null;
  /** PART 02: Deterministic discrepancy codes (array stored as JSON). */
  discrepancyCodes: VendorInvoiceDiscrepancyCode[];
  /** PART 03: Payment status (UNPAID / PARTIALLY_PAID / PAID). */
  paymentStatus: VendorPaymentStatus;
  /** PART 03: Cumulative recognized paid amount. */
  paidAmount: string;
  /** PART 03: Outstanding amount (invoice_amount - paid_amount). */
  outstandingAmount: string;
  /** PART 03: Date of the most recent payment. */
  lastPaymentDate: string | null;
  finalizedAt: Date | null;
  finalizedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorInvoice = Omit<
  VendorInvoiceRecord,
  | 'invoiceAmount'
  | 'paidAmount'
  | 'outstandingAmount'
  | 'verifiedAt'
  | 'finalizedAt'
  | 'cancelledAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  invoiceAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  verifiedAt: string | null;
  finalizedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Existing Vendor Invoice command tokens exposed to frontend callers. */
export const VENDOR_INVOICE_ACTIONS = [
  'FINALIZE',
  'CANCEL',
  'VERIFY',
  'RECORD_PAYMENT',
] as const;
export type VendorInvoiceAction = (typeof VENDOR_INVOICE_ACTIONS)[number];

export type VendorInvoiceAvailableActions = {
  vendorInvoiceId: string;
  state: VendorInvoiceStatus;
  verificationStatus: VendorInvoiceVerificationStatus;
  matchingStatus: VendorInvoiceMatchingStatus;
  settlementReadiness: VendorSettlementReadiness;
  availableActions: VendorInvoiceAction[];
};

/** Existing upstream states eligible for Vendor Invoice linkage. */
export const VENDOR_INVOICE_ELIGIBLE_PURCHASE_ORDER_STATUSES = [
  'ISSUED',
] as const;
export const VENDOR_INVOICE_ELIGIBLE_WORK_CONTRACT_STATUSES = [
  'ACTIVE',
  'COMPLETED',
] as const;

export function isVendorInvoiceEligiblePurchaseOrderStatus(
  value: string,
): boolean {
  return (
    VENDOR_INVOICE_ELIGIBLE_PURCHASE_ORDER_STATUSES as readonly string[]
  ).includes(value);
}

export function isVendorInvoiceEligibleWorkContractStatus(
  value: string,
): boolean {
  return (
    VENDOR_INVOICE_ELIGIBLE_WORK_CONTRACT_STATUSES as readonly string[]
  ).includes(value);
}

/** Input supplied by the API consumer when creating a Vendor Invoice. */
export type CreateVendorInvoiceInput = {
  buildingId: string;
  invoiceNumber: string;
  invoiceDate: string;
  receivedDate: string;
  currency: VendorInvoiceCurrency;
  invoiceAmount: number;
  vendorReference?: string | null;
  vendorWorkId?: string;
  workOrderId?: string;
  completionReportId?: string;
  serviceReportId?: string;
  bastDocumentId?: string;
  /**
   * Optional procurement linkage. The PO must be ISSUED. When supplied, the
   * SPK must be ACTIVE or COMPLETED and belong to that PO. Client, Building
   * and Vendor are validated against the authoritative chain.
   */
  purchaseOrderId?: string;
  workContractId?: string;
  notes?: string | null;
};

/** Fully-resolved Vendor Invoice data ready for persistence. */
export type NewVendorInvoice = {
  clientId: string;
  buildingId: string;
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  receivedDate: string;
  currency: VendorInvoiceCurrency;
  invoiceAmount: number;
  status: VendorInvoiceStatus;
  vendorReference: string | null;
  vendorWorkId: string | null;
  workOrderId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  bastDocumentId: string | null;
  purchaseOrderId: string | null;
  workContractId: string | null;
  notes: string | null;
  createdByUserId: string;
  verificationStatus: VendorInvoiceVerificationStatus;
  discrepancyCodes: VendorInvoiceDiscrepancyCode[];
  paymentStatus: VendorPaymentStatus;
  paidAmount: number;
};

/** Partial update input (PATCH /vendor-invoices/:id). DRAFT only. */
export type UpdateVendorInvoiceInput = {
  invoiceDate?: string;
  receivedDate?: string;
  currency?: VendorInvoiceCurrency;
  invoiceAmount?: number;
  vendorReference?: string | null;
  notes?: string | null;
};

/** List filters for GET /vendor-invoices. */
export type VendorInvoiceFilters = {
  vendorId?: string;
  buildingId?: string;
  workOrderId?: string;
  /** CR-BE-R2P-01 PART 06 — filter by the linked commercial chain. */
  purchaseOrderId?: string;
  workContractId?: string;
  status?: VendorInvoiceStatus;
  invoiceDateFrom?: string;
  invoiceDateTo?: string;
};

// ─── PART 02: Verification / Matching ───────────────────────────

/**
 * Verification status for a Vendor Invoice.
 * PENDING: not yet verified (default on creation).
 * VERIFIED: all matching checks passed.
 * DISCREPANCY: one or more checks failed; discrepancyCodes is populated.
 */
export const VENDOR_INVOICE_VERIFICATION_STATUSES = [
  'PENDING',
  'VERIFIED',
  'DISCREPANCY',
] as const;

export type VendorInvoiceVerificationStatus =
  (typeof VENDOR_INVOICE_VERIFICATION_STATUSES)[number];

export function isVendorInvoiceVerificationStatus(
  value: unknown,
): value is VendorInvoiceVerificationStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_INVOICE_VERIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Canonical, derived matching outcome. This is not an invoice lifecycle. */
export const VENDOR_INVOICE_MATCHING_STATUSES = [
  'MATCHED',
  'MISMATCH',
  'NOT_READY',
] as const;
export type VendorInvoiceMatchingStatus =
  (typeof VENDOR_INVOICE_MATCHING_STATUSES)[number];

/** Deterministic reason codes emitted by the one canonical matching result. */
export const VENDOR_INVOICE_DISCREPANCY_CODES = [
  'VENDOR_MISMATCH',
  'WORK_ORDER_NOT_FOUND',
  'WORK_ORDER_SCOPE_MISMATCH',
  'VENDOR_WORK_NOT_FOUND',
  'VENDOR_WORK_VENDOR_MISMATCH',
  'PURCHASE_ORDER_NOT_FOUND',
  'PURCHASE_ORDER_NOT_ISSUED',
  'PURCHASE_ORDER_SCOPE_MISMATCH',
  'PURCHASE_ORDER_VENDOR_MISMATCH',
  'WORK_CONTRACT_NOT_FOUND',
  'WORK_CONTRACT_PO_MISMATCH',
  'WORK_CONTRACT_SCOPE_MISMATCH',
  'WORK_CONTRACT_VENDOR_MISMATCH',
  'WORK_CONTRACT_NOT_ELIGIBLE',
  'PURCHASE_ORDER_LINES_NOT_FOUND',
  'CURRENCY_MISMATCH',
  'INVOICE_PO_AMOUNT_MISMATCH',
  'MATERIAL_REQUEST_NOT_FOUND',
  'MATERIAL_RECEIVING_NOT_COMPLETE',
  'MATERIAL_RECEIVING_OVER_APPROVED',
  'SERVICE_RECEIVING_NOT_FINALIZED',
  'COMPLETION_REPORT_NOT_FOUND',
  'COMPLETION_REPORT_NOT_SUBMITTED',
  'SERVICE_REPORT_NOT_FOUND',
  'SERVICE_REPORT_NOT_FINALIZED',
  'BAST_NOT_FOUND',
  'BAST_REQUIRED_NOT_AVAILABLE',
  'BAST_NOT_ACCEPTED',
  'AMOUNT_INVALID',
] as const;

export type VendorInvoiceDiscrepancyCode =
  (typeof VENDOR_INVOICE_DISCREPANCY_CODES)[number];

export function isVendorInvoiceDiscrepancyCode(
  value: unknown,
): value is VendorInvoiceDiscrepancyCode {
  return (
    typeof value === 'string' &&
    (VENDOR_INVOICE_DISCREPANCY_CODES as readonly string[]).includes(value)
  );
}

/**
 * Deterministic matching result for a single check.
 * `matched: true` means the check passed; `discrepancy` is the code
 * when it failed.
 */
export type InvoiceMatchingCheck = {
  check: string;
  /** False when an optional reference is absent and the check does not apply. */
  applicable: boolean;
  status: VendorInvoiceMatchingStatus;
  /** Backward-compatible convenience: true exactly when status is MATCHED. */
  matched: boolean;
  discrepancy: VendorInvoiceDiscrepancyCode | null;
};

/**
 * Full deterministic matching result returned by the verification
 * evaluation. This is the audit trail — every check is explicit.
 */
export type InvoiceMatchingResult = {
  invoiceId: string;
  status: VendorInvoiceMatchingStatus;
  verificationEligible: boolean;
  vendorMatch: InvoiceMatchingCheck;
  purchaseOrderMatch: InvoiceMatchingCheck;
  workContractMatch: InvoiceMatchingCheck;
  amountMatch: InvoiceMatchingCheck;
  receivingMatch: InvoiceMatchingCheck;
  workOrderMatch: InvoiceMatchingCheck;
  vendorWorkMatch: InvoiceMatchingCheck;
  completionMatch: InvoiceMatchingCheck;
  serviceMatch: InvoiceMatchingCheck;
  bastMatch: InvoiceMatchingCheck;
  /** Backward-compatible convenience: true only when status is MATCHED. */
  allMatched: boolean;
  mismatchCodes: VendorInvoiceDiscrepancyCode[];
  notReadyCodes: VendorInvoiceDiscrepancyCode[];
  /** All non-matched reasons, retained for verification persistence. */
  discrepancyCodes: VendorInvoiceDiscrepancyCode[];
  evaluatedAt: string;
};

/** Input for the verify endpoint body (optional notes). */
export type VerifyVendorInvoiceInput = {
  notes?: string;
};

// ─── PART 03: Payment Status ────────────────────────────────────

/**
 * Vendor Payment Status — derived deterministically from
 * paid_amount vs invoice_amount.
 *
 * UNPAID:          paid_amount = 0
 * PARTIALLY_PAID:  0 < paid_amount < invoice_amount
 * PAID:            paid_amount >= invoice_amount
 *
 * Overpayment (paid_amount > invoice_amount) is rejected.
 */
export const VENDOR_PAYMENT_STATUSES = [
  'UNPAID',
  'PARTIALLY_PAID',
  'PAID',
] as const;

export type VendorPaymentStatus = (typeof VENDOR_PAYMENT_STATUSES)[number];

export function isVendorPaymentStatus(
  value: unknown,
): value is VendorPaymentStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Derives payment status deterministically from paid and invoice amounts.
 */
export function derivePaymentStatus(
  paidAmount: number,
  invoiceAmount: number,
): VendorPaymentStatus {
  if (paidAmount <= 0) return 'UNPAID';
  if (paidAmount >= invoiceAmount) return 'PAID';
  return 'PARTIALLY_PAID';
}

/** NUMERIC(18,2) upper bound is exclusive at 10^16. */
const VENDOR_PAYMENT_AMOUNT_MAX_EXCLUSIVE = 10_000_000_000_000_000;

/**
 * Payment commands use JSON numbers but persist to NUMERIC(18,2). This guard
 * rejects values PostgreSQL would have to round, as well as values outside the
 * column's supported integer precision.
 */
export function isValidVendorPaymentAmount(value: unknown): value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value >= VENDOR_PAYMENT_AMOUNT_MAX_EXCLUSIVE
  ) {
    return false;
  }

  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const fractionLength = coefficient.split('.')[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent) <= 2;
}

/** Input for recording a payment against a Vendor Invoice. */
export type RecordVendorPaymentInput = {
  amount: number;
  paymentDate?: string;
  notes?: string;
};

// ─── PART 04: Settlement Readiness ──────────────────────────────

/** Derived payment eligibility; this is not a parallel payment lifecycle. */
export const VENDOR_SETTLEMENT_READINESS = [
  'READY',
  'NOT_READY',
  'SETTLED',
] as const;
export type VendorSettlementReadiness =
  (typeof VENDOR_SETTLEMENT_READINESS)[number];

/** Deterministic reasons why payment eligibility is NOT_READY. */
export const VENDOR_SETTLEMENT_REASONS = [
  'INVOICE_NOT_FINALIZED',
  'INVOICE_CANCELLED',
  'INVOICE_NOT_VERIFIED',
  'MATCHING_NOT_READY',
  'MATCHING_MISMATCH',
  'SCOPE_MISMATCH',
  'INVALID_INVOICE_AMOUNT',
  'INVALID_CURRENCY',
  'INVALID_PAYMENT_STATE',
] as const;
export type VendorSettlementReason =
  (typeof VENDOR_SETTLEMENT_REASONS)[number];

/** Backward-compatible exported name; values now represent readiness reasons. */
export const VENDOR_SETTLEMENT_BLOCKERS = VENDOR_SETTLEMENT_REASONS;
export type VendorSettlementBlocker = VendorSettlementReason;

/** The only existing payment command advertised by readiness. */
export const VENDOR_SETTLEMENT_ACTIONS = ['RECORD_PAYMENT'] as const;
export type VendorSettlementAction =
  (typeof VENDOR_SETTLEMENT_ACTIONS)[number];

/** Canonical read-only eligibility projection over existing invoice/payment state. */
export type VendorSettlementReadinessResult = {
  invoiceId: string;
  readiness: VendorSettlementReadiness;
  invoiceStatus: VendorInvoiceStatus;
  verificationStatus: VendorInvoiceVerificationStatus;
  matchingStatus: VendorInvoiceMatchingStatus;
  paymentStatus: VendorPaymentStatus;
  currency: VendorInvoiceCurrency;
  invoiceAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  reasons: VendorSettlementReason[];
  /** Backward-compatible alias of reasons. */
  blockers: VendorSettlementReason[];
  matchingReasons: VendorInvoiceDiscrepancyCode[];
  consistencyReasons: VendorConsistencyCode[];
  availableActions: VendorSettlementAction[];
  evaluatedAt: string;
};

// ─── PART 05: Vendor Consistency Cross-Check ────────────────────

/**
 * Deterministic vendor consistency check result for each validation.
 * `consistent: true` means the check passed; `reason` is the code
 * when it failed.
 */
export const VENDOR_CONSISTENCY_CODES = [
  'INVOICE_VENDOR_WORK_MISMATCH',
  'VENDOR_WORK_WORK_ORDER_MISMATCH',
  'PROCUREMENT_VENDOR_MISMATCH',
  'CROSS_CLIENT_REFERENCE',
  'CROSS_BUILDING_REFERENCE',
] as const;

export type VendorConsistencyCode =
  (typeof VENDOR_CONSISTENCY_CODES)[number];

export function isVendorConsistencyCode(
  value: unknown,
): value is VendorConsistencyCode {
  return (
    typeof value === 'string' &&
    (VENDOR_CONSISTENCY_CODES as readonly string[]).includes(value)
  );
}

export type VendorConsistencyCheck = {
  check: string;
  consistent: boolean;
  reason: VendorConsistencyCode | null;
};

export type VendorConsistencyResult = {
  vendorWorkVendorMatch: VendorConsistencyCheck;
  workOrderAssignedVendorMatch: VendorConsistencyCheck;
  procurementVendorMatch: VendorConsistencyCheck;
  clientIsolationMatch: VendorConsistencyCheck;
  buildingIsolationMatch: VendorConsistencyCheck;
  allConsistent: boolean;
  inconsistencyCodes: VendorConsistencyCode[];
};

// ─── PART 05: BAST Hard Gate ────────────────────────────────────

/**
 * BAST hard gate evaluation result.
 *
 * required: Whether BAST is required by the Work Order's bastRequirement.
 * gatePassed: Whether the canonical BAST is ACCEPTED (or not required).
 * bastStatus: The acceptance status of the referenced BAST (if any).
 * isLegacyProjection: Whether the BAST reference comes from legacy
 *   vendor_bast_bindings only (cannot satisfy the gate).
 */
export type BastHardGateResult = {
  required: boolean;
  gatePassed: boolean;
  bastStatus: string | null;
  isLegacyProjection: boolean;
  bastDocumentId: string | null;
  workOrderBastRequirement: string | null;
};

// ─── PART 05/CR-BE-R2P-CONTRACT-01 PART 06: R2P Trace ──────────

export const R2P_TRACE_DOCUMENT_TYPES = [
  'PURCHASE_REQUEST',
  'MATERIAL_REQUEST',
  'SERVICE_REQUEST',
  'PROCUREMENT_APPROVAL',
  'PURCHASE_ORDER',
  'PURCHASE_ORDER_LINE',
  'WORK_CONTRACT',
  'RECEIVING',
  'WORK_ORDER',
  'VENDOR_WORK',
  'COMPLETION_REPORT',
  'SERVICE_REPORT',
  'BAST',
  'VENDOR_INVOICE',
  'INVOICE_MATCHING',
  'INVOICE_VERIFICATION',
  'PAYMENT_STATE',
  'SETTLEMENT_READINESS',
] as const;
export type R2PTraceDocumentType =
  (typeof R2P_TRACE_DOCUMENT_TYPES)[number];

export const R2P_TRACE_RELATIONSHIPS = [
  'SOURCE_OF',
  'APPROVED_BY',
  'COMMITTED_BY_LINE',
  'BELONGS_TO',
  'MANDATES',
  'RECEIVED_AS',
  'BOUND_TO',
  'EXECUTED_AS',
  'REPORTED_BY',
  'ACCEPTED_BY',
  'INVOICED_BY',
  'PROJECTS',
] as const;
export type R2PTraceRelationshipType =
  (typeof R2P_TRACE_RELATIONSHIPS)[number];

export type R2PTraceDocument = {
  documentType: R2PTraceDocumentType;
  documentId: string;
  documentNumber: string | null;
  status: string | null;
};

export type R2PTraceRelationship = {
  relationship: R2PTraceRelationshipType;
  sourceDocumentType: R2PTraceDocumentType;
  sourceDocumentId: string;
  targetDocumentType: R2PTraceDocumentType;
  targetDocumentId: string;
};

/**
 * Stable traceability references plus a canonical, non-persisted R2P graph.
 * Existing flat fields remain for compatibility.
 */
export type VendorInvoiceTrace = {
  invoiceId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  vendorWorkId: string | null;
  workOrderId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  bastDocumentId: string | null;
  /**
   * CR-BE-R2P-01 PART 06 — the procurement chain behind this invoice, so the
   * linkage is traceable in the read model.
   */
  purchaseOrderId: string | null;
  workContractId: string | null;
  /** Status of the linked PO, read verbatim from the PO authority. */
  purchaseOrderStatus: string | null;
  purchaseOrderNumber: string | null;
  /** Status of the linked SPK, read verbatim from the SPK authority. */
  workContractStatus: string | null;
  workContractSpkNumber: string | null;
  /** The vendor assigned to the Work Order (via vendor_assignments). */
  workOrderAssignedVendorId: string | null;
  /** Work Order BAST requirement policy. */
  workOrderBastRequirement: string | null;
  /** Canonical BAST acceptance status (if referenced). */
  bastAcceptanceStatus: string | null;
  /** Whether the BAST reference is from legacy vendor_bast_bindings. */
  bastIsLegacyProjection: boolean;
  verificationStatus: VendorInvoiceVerificationStatus;
  paymentStatus: VendorPaymentStatus;
  invoiceStatus: VendorInvoiceStatus;
  documents: R2PTraceDocument[];
  relationships: R2PTraceRelationship[];
  matching: InvoiceMatchingResult;
  settlementReadiness: VendorSettlementReadinessResult;
  generatedAt: string;
};

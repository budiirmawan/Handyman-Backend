/**
 * CR-BE-R2P-01 PART 01 — Purchase Order domain types.
 *
 * A Purchase Order is the authoritative COMMITMENT to a Vendor for an
 * approved Procurement request. It is the missing R2P link between
 * "may commit" (BE-17F PO Readiness) and downstream execution/settlement:
 *
 *   Request → PO Readiness → **PO** → SPK → Work Order → BAST
 *           → Vendor Invoice → Verification → Payment → Settlement
 *
 * Frozen PART 01 decisions:
 *
 *  1. PO Readiness is a PRECONDITION, never duplicated. `poReadinessId` is
 *     required and the referenced BE-17F record must be READY at commit
 *     time. This module defines NO readiness enum, NO checks and NO second
 *     readiness evaluator — `READY` means "may commit", an issued PO means
 *     "committed".
 *
 *  2. Material Request (BE-17B) / Service Request (BE-17C) remain the
 *     QUANTITY authority. This type carries no quantity, no ordered/received
 *     ledger and no amount total. PO Lines (PART 02) will reference request
 *     lines and snapshot commercial terms only.
 *
 *  3. SPK / Work Contract is its own entity (PART 04); its Work Order
 *     linkage is PART 05. Nothing here duplicates the BE-17H Work Order
 *     Procurement Binding domain.
 *
 * Out of PART 01 scope entirely: PO Lines, issuance/approval workflow,
 * receiving-gate changes, material quantity logic, invoice/payment.
 */

/**
 * PO lifecycle foundation.
 *
 *   DRAFT     — commitment prepared; still editable.
 *   ISSUED    — committed to the Vendor and terminal for current API commands.
 *   CANCELLED — draft commitment cancelled before issuance; terminal.
 */
export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'ISSUED',
  'CANCELLED',
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export function isPurchaseOrderStatus(
  value: unknown,
): value is PurchaseOrderStatus {
  return (
    typeof value === 'string' &&
    (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Authoritative API lifecycle transitions.
 *
 * A DRAFT commitment may be issued when issue-readiness passes, or cancelled
 * before issuance. The current service exposes no ISSUED cancellation command;
 * ISSUED and CANCELLED therefore have no outgoing API transitions. The storage
 * schema can preserve issuance provenance on historical/imported CANCELLED
 * rows, but that compatibility shape is not an executable transition.
 */
export const PURCHASE_ORDER_TRANSITIONS: Record<
  PurchaseOrderStatus,
  readonly PurchaseOrderStatus[]
> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: [],
  CANCELLED: [],
};

export function canTransitionPurchaseOrderStatus(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): boolean {
  return (
    PURCHASE_ORDER_TRANSITIONS[from] as readonly PurchaseOrderStatus[]
  ).includes(to);
}

/**
 * The source request type behind the commitment. Mirrors BE-17F
 * `PO_READINESS_REQUEST_TYPES` exactly — the PO never widens or narrows the
 * readiness vocabulary.
 */
export const PURCHASE_ORDER_REQUEST_TYPES = [
  'PURCHASE_REQUEST',
  'SERVICE_REQUEST',
] as const;

export type PurchaseOrderRequestType =
  (typeof PURCHASE_ORDER_REQUEST_TYPES)[number];

export function isPurchaseOrderRequestType(
  value: unknown,
): value is PurchaseOrderRequestType {
  return (
    typeof value === 'string' &&
    (PURCHASE_ORDER_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Supported ISO 4217 currency codes. Deliberately identical to
 * `VENDOR_INVOICE_CURRENCIES` so the commitment and the payable speak the
 * same commercial vocabulary.
 */
export const PURCHASE_ORDER_CURRENCIES = [
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

export type PurchaseOrderCurrency =
  (typeof PURCHASE_ORDER_CURRENCIES)[number];

export function isPurchaseOrderCurrency(
  value: unknown,
): value is PurchaseOrderCurrency {
  return (
    typeof value === 'string' &&
    (PURCHASE_ORDER_CURRENCIES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PurchaseOrderRecord = {
  id: string;
  /** Derived from the qualifying PO Readiness — never client-supplied. */
  clientId: string;
  /** Derived from the qualifying PO Readiness — never client-supplied. */
  buildingId: string;
  /** PO identity foundation: unique within a Client. */
  poNumber: string;
  poDate: string;
  /** Derived from the qualifying PO Readiness — the committed Vendor. */
  vendorId: string;
  requestType: PurchaseOrderRequestType;
  /** Exactly one of purchaseRequestId / serviceRequestId is set. */
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  /** Required precondition: the BE-17F readiness that qualified this commit. */
  poReadinessId: string;
  currency: PurchaseOrderCurrency;
  status: PurchaseOrderStatus;
  /** The Vendor's own reference (quotation / order number). */
  vendorReference: string | null;
  requiredDate: string | null;
  notes: string | null;
  createdByUserId: string;
  /** PART 03: when the commitment was issued to the Vendor. */
  issuedAt: Date | null;
  /** PART 03: who issued it (issuance provenance). */
  issuedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicPurchaseOrder = Omit<
  PurchaseOrderRecord,
  'issuedAt' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  issuedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Input supplied by the API consumer when committing a Purchase Order.
 *
 * `poReadinessId` is the ONLY context input: Client, Building, Vendor and the
 * request reference are all resolved from that readiness record, so a caller
 * can neither widen its own scope nor commit a vendor that was never
 * selected for the request.
 */
export type CreatePurchaseOrderInput = {
  poReadinessId: string;
  poNumber: string;
  poDate: string;
  currency: PurchaseOrderCurrency;
  vendorReference?: string | null;
  requiredDate?: string | null;
  notes?: string | null;
};

/** Fully-resolved Purchase Order data ready for persistence. */
export type NewPurchaseOrder = {
  clientId: string;
  buildingId: string;
  poNumber: string;
  poDate: string;
  vendorId: string;
  requestType: PurchaseOrderRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  poReadinessId: string;
  currency: PurchaseOrderCurrency;
  status: PurchaseOrderStatus;
  vendorReference: string | null;
  requiredDate: string | null;
  notes: string | null;
  createdByUserId: string;
};

/**
 * Partial update input (PATCH /purchase-orders/:id). DRAFT only.
 *
 * Identity (`poNumber`), commitment context (`poReadinessId`, `vendorId`,
 * request references) and derived scope (`clientId`, `buildingId`) are
 * immutable — a commitment is never silently re-pointed at another vendor,
 * request or readiness.
 */
export type UpdatePurchaseOrderInput = {
  poDate?: string;
  currency?: PurchaseOrderCurrency;
  vendorReference?: string | null;
  requiredDate?: string | null;
  notes?: string | null;
};

/** List filters for GET /purchase-orders. */
export type PurchaseOrderFilters = {
  vendorId?: string;
  buildingId?: string;
  purchaseRequestId?: string;
  serviceRequestId?: string;
  status?: PurchaseOrderStatus;
  poDateFrom?: string;
  poDateTo?: string;
};

// ─── PART 03: Issue / Status / Approval Readiness ───────────────

/**
 * CR-BE-R2P-CONTRACT-01 PART 01 — caller-specific lifecycle actions.
 *
 * These tokens map one-to-one to existing commands. They introduce no new
 * transition or permission: ISSUE maps to POST /purchase-orders/:id/issue and
 * CANCEL maps to POST /purchase-orders/:id/cancel.
 */
export const PURCHASE_ORDER_ACTIONS = ['ISSUE', 'CANCEL'] as const;
export type PurchaseOrderAction = (typeof PURCHASE_ORDER_ACTIONS)[number];

/** Established backend available-actions DTO shape: id + state + actions. */
export type PurchaseOrderAvailableActions = {
  purchaseOrderId: string;
  state: PurchaseOrderStatus;
  availableActions: PurchaseOrderAction[];
};

/**
 * Deterministic reasons why a Purchase Order may not be issued right now.
 *
 * These are READINESS FACTS about the commitment, resolved at evaluation
 * time from authorities that already exist. They are never persisted on the
 * Purchase Order and they do NOT constitute a second readiness authority:
 * `PO_READINESS_NOT_READY` simply reports BE-17F's own verdict, which stays
 * the sole readiness authority and a hard precondition.
 *
 * Mirrors the established blocker-code pattern
 * (`BAST_CLOSURE_BLOCKER_CODES`, `VENDOR_SETTLEMENT_BLOCKERS`).
 */
export const PURCHASE_ORDER_ISSUE_BLOCKERS = [
  /** The PO is not in DRAFT (already issued, or cancelled). */
  'PO_NOT_DRAFT',
  /** BE-17F readiness is missing/unreadable. */
  'PO_READINESS_INVALID',
  /** BE-17F readiness is not READY (its verdict, reported verbatim). */
  'PO_READINESS_NOT_READY',
  /** The PO carries no lines — an empty commitment is never issuable. */
  'NO_PURCHASE_ORDER_LINES',
  /** The PO's request reference is missing or internally inconsistent. */
  'REQUEST_LINKAGE_INVALID',
  /** A committed line no longer points at a valid, live request line. */
  'REQUEST_LINE_INVALID',
  /** Vendor is inactive, cross-Client, or lost its Building relationship. */
  'VENDOR_NOT_COMMITTABLE',
  /** Vendor/readiness/line scope disagrees with the PO's Client+Building. */
  'SCOPE_INCONSISTENT',
] as const;

export type PurchaseOrderIssueBlocker =
  (typeof PURCHASE_ORDER_ISSUE_BLOCKERS)[number];

/**
 * Read-only issue-readiness evaluation for a Purchase Order.
 *
 * Pure projection — evaluating it mutates nothing. `availableActions`
 * contains `issue` only when the commitment is issuable, following the
 * backend-authoritative available-actions convention.
 */
export type PurchaseOrderIssueReadinessResult = {
  purchaseOrderId: string;
  status: PurchaseOrderStatus;
  issuable: boolean;
  /** BE-17F's own verdict, reported verbatim; null when unreadable. */
  poReadiness: string | null;
  lineCount: number;
  blockers: PurchaseOrderIssueBlocker[];
  availableActions: PurchaseOrderAction[];
  evaluatedAt: string;
};

/** Input for the issue command (optional issuance note). */
export type IssuePurchaseOrderInput = {
  notes?: string;
};

/**
 * CR-BE-R2P-01 PART 02 — PO Line & Request Linkage domain types.
 *
 * A Purchase Order Line is the COMMERCIAL COMMITMENT over exactly one
 * originating request line:
 *
 *   Material Request line (BE-17B) ─┐
 *                                   ├─► PO Line ─► Purchase Order (PART 01)
 *   Service Request      (BE-17C) ─┘
 *
 * QUANTITY AUTHORITY IS UNCHANGED — `material_requests` remains the single
 * quantity authority. This module creates NO ordered / received / remaining
 * quantity ledger and NO inventory ledger, and it changes no Material Request
 * quantity, approval, receiving or over-receipt logic.
 *
 * `quantitySnapshot` is a frozen copy of the request line's authoritative
 * quantity (`approvedQuantity ?? quantity`) taken at commit time so the
 * commercial amount can be priced and audited. It is backend-derived, never
 * client-supplied, never recomputed and never mutated. Fulfilment continues
 * to read `material_requests` alone.
 *
 * Out of PART 02 scope: PO issuance/approval workflow (PART 03), SPK
 * (PART 04), SPK↔WO linkage (PART 05), receiving/vendor-invoice/payment
 * changes, OpenAPI completion.
 */

/** Which originating request line this commitment covers. */
export const PO_LINE_REQUEST_TYPES = [
  'MATERIAL_REQUEST',
  'SERVICE_REQUEST',
] as const;

export type PurchaseOrderLineRequestType =
  (typeof PO_LINE_REQUEST_TYPES)[number];

export function isPurchaseOrderLineRequestType(
  value: unknown,
): value is PurchaseOrderLineRequestType {
  return (
    typeof value === 'string' &&
    (PO_LINE_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PurchaseOrderLineRecord = {
  id: string;
  purchaseOrderId: string;
  /** Derived from the parent Purchase Order — never client-supplied. */
  clientId: string;
  /** Derived from the parent Purchase Order — never client-supplied. */
  buildingId: string;
  /** Deterministic ordering within the Purchase Order; unique per PO. */
  lineNumber: number;
  requestLineType: PurchaseOrderLineRequestType;
  /** Exactly one of materialRequestId / serviceRequestId is set. */
  materialRequestId: string | null;
  serviceRequestId: string | null;
  /** Item identity snapshot (MATERIAL_REQUEST only). */
  itemId: string | null;
  /** UOM snapshot at commit time (MATERIAL_REQUEST only). */
  uomId: string | null;
  /**
   * CR-BE-SVC-01 PART 04 — governed SERVICE identity snapshot
   * (SERVICE_REQUEST only; NULL for MATERIAL_REQUEST and un-governed SERVICE
   * lines). Frozen at commit; never introduces item/UOM/quantity.
   */
  sourceServiceId: string | null;
  description: string;
  /**
   * Frozen copy of the request line's authoritative quantity at commit time.
   * NOT a quantity authority and NOT a ledger. NULL for a Service Request.
   */
  quantitySnapshot: number | null;
  unitPrice: number;
  lineAmount: number;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicPurchaseOrderLine = Omit<
  PurchaseOrderLineRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * Input for committing one PO Line.
 *
 * The caller identifies the originating request line and supplies the
 * commercial terms only. Client, Building, item, UOM and the quantity
 * snapshot are all derived from the parent PO and the request line, so a
 * caller can neither widen scope nor invent a quantity.
 */
export type AddPurchaseOrderLineInput = {
  requestLineType: PurchaseOrderLineRequestType;
  /** Material Request line id, or Service Request id. */
  requestLineId: string;
  unitPrice: number;
  /** Optional override of the derived description snapshot. */
  description?: string;
  notes?: string | null;
};

/** Fully-resolved line data ready for persistence. */
export type NewPurchaseOrderLine = {
  purchaseOrderId: string;
  clientId: string;
  buildingId: string;
  lineNumber: number;
  requestLineType: PurchaseOrderLineRequestType;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  itemId: string | null;
  uomId: string | null;
  sourceServiceId: string | null;
  description: string;
  quantitySnapshot: number | null;
  unitPrice: number;
  lineAmount: number;
  notes: string | null;
  createdByUserId: string;
};

/**
 * Partial update input (PATCH /purchase-order-lines/:id). DRAFT PO only.
 *
 * Only commercial terms may change. The request linkage, derived snapshots
 * (item, UOM, quantity) and ordering are immutable — a committed line is
 * never silently re-pointed at another request line, and the quantity
 * snapshot is never edited into a competing authority.
 */
export type UpdatePurchaseOrderLineInput = {
  unitPrice?: number;
  description?: string;
  notes?: string | null;
};

/** Compact acknowledgement returned after deleting a DRAFT PO line. */
export type RemovePurchaseOrderLineResult = {
  removed: true;
  purchaseOrderId: string;
  lineNumber: number;
};

/**
 * Derives the committed line amount from the frozen snapshot.
 *
 * A material line prices the snapshotted quantity; a service line has no
 * quantity, so the unit price IS the committed amount.
 */
export function deriveLineAmount(
  quantitySnapshot: number | null,
  unitPrice: number,
): number {
  if (quantitySnapshot === null) return unitPrice;
  return Number((quantitySnapshot * unitPrice).toFixed(2));
}

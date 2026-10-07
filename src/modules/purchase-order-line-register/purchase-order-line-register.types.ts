/**
 * R11 PART 03B — Purchase Order Line Register read contract types.
 *
 * READ MODEL ONLY. One flat row per authoritative `purchase_order_lines`
 * record (CR-BE-R2P-01 PART 02, extended by CR-BE-SVC-01 PART 04), joined
 * to its owning `purchase_orders` header (CR-BE-R2P-01 PART 01/03) for the
 * parent context a LINE-grain Reporting row requires. Prepared for Reporting
 * consumption by the PURCHASE_ORDER_REGISTER dataset's LINE view in a later
 * R11 PART (03C). This PART deliberately registers nothing: the Reporting
 * dataset enum stays at 19 until the adapter PART lands.
 *
 * WHY THIS MODULE EXISTS — the purchase-orders module's public line read
 * (`listPurchaseOrderLines`) is PER-PO: it asserts access to ONE parent and
 * lists that parent's lines. A cross-PO register built on it would require
 * list-POs → loop → per-PO line fetch (N+1), which is prohibited. This
 * contract is the missing SET-BASED, access-scoped LINE read: exactly one
 * bounded repository query across the caller's whole authorized Building
 * scope.
 *
 * NO HEADER DUPLICATION — the HEADER view stays owned directly by the
 * purchase-orders module (`parsePurchaseOrderFilters` + `listPurchaseOrders`,
 * already set-based and scoped). This module creates no header list, no
 * header repository, no second header SQL and no header read model; it joins
 * the header table READ-ONLY for parent context columns.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no purchase-order or line entity, lifecycle status, or
 *     persistence, and never mutates the frozen quantity snapshot.
 *   - NO ENRICHMENT: no RFQ provenance, no price-catalog reference, no
 *     price-deviation comparison, no receiving, vendor-invoice, SPK or work
 *     order linkage is joined or inferred — those remain separate drill
 *     authorities.
 *   - NO MONETARY ARITHMETIC: `unitPrice` and `lineAmount` are persisted
 *     historical transactional facts copied verbatim; `lineAmount` is never
 *     recomputed from `quantitySnapshot × unitPrice`, no PO total is summed,
 *     no currency conversion, tax or valuation exists anywhere here.
 *   - No display-name joins: IDs plus the parent's own `poNumber` context
 *     only, so no second read authority is duplicated and no fan-out is
 *     possible (the parent join is 1:1 on `purchase_orders.id`).
 *
 * Grain: exactly one row per `purchase_order_lines` row in scope.
 * Identity: `purchaseOrderLineId` — the line's own `purchase_order_lines.id`
 * renamed explicitly for the public register contract (the source record
 * field is `id`; this contract never publishes it under that ambiguous
 * name).
 *
 * PERIOD AUTHORITY — the parent PO's `po_date` (DATE, not TIMESTAMPTZ),
 * filtered INCLUSIVE on both ends ([dateFrom, dateTo] calendar dates),
 * identical in meaning to the HEADER authority's own `poDateFrom`/`poDateTo`
 * window so the future PURCHASE_ORDER_REGISTER dataset freezes ONE
 * date-filter meaning across both views. `line.created_at`, `po.created_at`
 * and `updated_at` are never business-period substitutes.
 */

export type PurchaseOrderLineRegisterFilters = {
  /** Explicit Building; existence-checked and access-asserted. Omitted = authorized rollup. */
  buildingId?: string;
  /** The parent PO's committed Vendor (`purchase_orders.vendor_id`). */
  vendorId?: string;
  /** The parent PO's request anchor (`purchase_orders.purchase_request_id`). */
  purchaseRequestId?: string;
  /**
   * The LINE's own originating Service Request (`purchase_order_lines.
   * service_request_id`) — the filter always matches the published field.
   * For a SERVICE_REQUEST PO this equals the parent's own committed Service
   * Request (the commit path enforces the identity); for a PURCHASE_REQUEST
   * PO the parent anchor is NULL while a service line still carries its
   * originating SR under that PR, so the line column is the only complete
   * fact and the parent's is never substituted for it.
   */
  serviceRequestId?: string;
  /** Native parent PO status: DRAFT | ISSUED | CANCELLED, verbatim vocabulary. */
  status?: string;
  /** Inclusive calendar date (YYYY-MM-DD) over the parent PO's `po_date`. */
  dateFrom?: string;
  /** Inclusive calendar date (YYYY-MM-DD); must not precede dateFrom. */
  dateTo?: string;
  /** LINE-specific: the line's own originating Material Request line. */
  materialRequestId?: string;
  /** LINE-specific: the line's item identity snapshot (MATERIAL lines only). */
  itemId?: string;
};

/** One flat register row: LINE facts plus read-only parent PO context. */
export type PublicPurchaseOrderLineRegisterRow = {
  // ── IDENTITY ──────────────────────────────────────────────────────────
  /** `purchase_order_lines.id` — the row identity, explicitly named. */
  purchaseOrderLineId: string;

  // ── PARENT CONTEXT (verbatim from the owning purchase_orders row) ─────
  purchaseOrderId: string;
  clientId: string;
  buildingId: string;
  /** The parent PO's committed Vendor. */
  vendorId: string;
  /** The parent PO's request anchor; exactly one of PR/SR is non-null (schema CHECK). */
  purchaseRequestId: string | null;
  /** The parent PO's identity: unique within a Client. */
  poNumber: string;
  /** The parent PO's business date (YYYY-MM-DD) — the period authority. */
  poDate: string;
  /** The parent PO's ISO-4217 currency — the ONE authoritative currency of every line amount. */
  currency: string;
  /**
   * The PARENT PO's native lifecycle status (DRAFT | ISSUED | CANCELLED),
   * exposed under an explicit semantic name: a line owns NO independent
   * lifecycle status, so this is never called `status` or `lineStatus`.
   */
  purchaseOrderStatus: string;

  // ── LINE FACTS (verbatim from the purchase_order_lines row) ───────────
  /** Deterministic ordering within the parent PO; unique per PO. */
  lineNumber: number;
  /**
   * The authoritative persisted discriminator: MATERIAL_REQUEST |
   * SERVICE_REQUEST (schema CHECK). Never inferred from nullable fields.
   */
  requestLineType: string;
  /** The line's own originating request line — exactly one is non-null (schema CHECK). */
  materialRequestId: string | null;
  serviceRequestId: string | null;
  /** Item identity snapshot (MATERIAL_REQUEST lines only; NULL for SERVICE). */
  itemId: string | null;
  /** UOM snapshot at commit time (MATERIAL_REQUEST lines only; NULL for SERVICE). */
  uomId: string | null;
  /** Governed SERVICE identity snapshot (CR-BE-SVC-01 PART 04); nullable on historical/MATERIAL lines. */
  sourceServiceId: string | null;
  /** Description snapshot frozen at commit time. */
  description: string;
  /**
   * Frozen copy of the request line's authoritative quantity at commit
   * time (`approvedQuantity ?? quantity`), copied verbatim. Historical
   * data only: NOT current demand, NOT an approved/received/remaining/
   * inventory quantity authority, never mutated, never used in arithmetic
   * here. NULL for SERVICE lines — preserved as NULL.
   */
  quantitySnapshot: number | null;
  /** Persisted committed unit price (NUMERIC(18,2)), verbatim. Never compared to any current catalog price. */
  unitPrice: number;
  /**
   * Persisted committed line amount (NUMERIC(18,2)), verbatim — derived
   * ONCE by the purchase-orders commit/update path from the frozen
   * snapshot and never recomputed here. Denominated in the parent PO's
   * `currency`; no FX, no tax, no valuation.
   */
  lineAmount: number;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicPurchaseOrderLineRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the scope resolution. */
  buildingScope: string[];
  /** Inclusive window boundaries over the parent PO's `po_date`, as accepted. */
  dateFrom: string | null;
  dateTo: string | null;
  /** The evaluation instant. */
  asOf: string;
  rows: PublicPurchaseOrderLineRegisterRow[];
};

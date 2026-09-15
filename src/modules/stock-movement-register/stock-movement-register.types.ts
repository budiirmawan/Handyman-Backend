/**
 * R11 PART 05B — Stock Movement Register read contract types.
 *
 * READ MODEL ONLY. One flat row per authoritative
 * `inventory_stock_movements` record (BE-16D append-only ledger, UOM
 * snapshot added by CR-BE-MAT-01 migration 0266), prepared for Reporting
 * consumption by the STOCK_MOVEMENT_REGISTER dataset in a later R11 PART.
 * This PART deliberately registers nothing: the Reporting dataset enum
 * stays at 21 until the adapter PART lands.
 *
 * WHY THIS FOUNDATION EXISTS — R11 PART 05 source verification proved the
 * existing public `listMovements` read is not Reporting-safe: `actorUserId`
 * is optional, no accessible-Building rollup exists in its read path, there
 * is no fail-closed empty authorized scope, no governed list-query parser
 * exists, raw date strings flow unvalidated into TIMESTAMPTZ filtering, a
 * date-only `dateTo` truncates the final day at midnight (`<=`
 * dateTo-midnight), the public list adds warehouse/item display-name
 * enrichment, and it derives a nested resolved-balance object (including a
 * reserved quantity by subtraction). The owning module is NOT modified;
 * this module is a new narrow internal read authority instead.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no movement entity, lifecycle, or persistence. The
 *     movements ledger stays append-only and immutable under its owning
 *     domain.
 *   - `movementType` is the native persisted DIRECTION/TYPE discriminator
 *     (STOCK_IN | STOCK_OUT, schema CHECK in migration 0169), verbatim. It
 *     is NOT a lifecycle state and is never normalized to any other
 *     vocabulary; this contract has no generic lifecycle field at all.
 *   - NO CURRENT-BALANCE AUTHORITY. `resultingQuantityOnHand` and
 *     `resultingAvailableQuantity` are the persisted HISTORICAL
 *     post-movement snapshots of the movement row — the on-hand/available
 *     quantities recorded immediately after that movement posted. They are
 *     never relabeled as current inventory and never re-resolved against
 *     the live stock-balance domain, which stays the sole current-balance
 *     authority. No resolved-balance object is nested here and no reserved
 *     quantity is derived by subtraction or any other arithmetic.
 *   - NO MONETARY AUTHORITY. A stock movement is a quantity fact: no
 *     unit/total/average/standard cost, inventory or stock value, COGS,
 *     price, amount, currency, FIFO/LIFO/weighted-average or any other
 *     valuation field exists on this contract, and none is inferred from
 *     purchase orders, vendor invoices, price catalog, receivings or
 *     work-order material usage.
 *   - NO REVERSE-DOMAIN ENRICHMENT. Even though receivings, work-order
 *     material usages and other domains may persist a reference to a
 *     movement id, this register never joins back into them. The generic
 *     persisted `reference` / `source` texts are copied verbatim and are
 *     never reinterpreted as a Receiving, Work Order, Purchase Order,
 *     Material Request, Reservation, Transfer or Adjustment link, and no
 *     reference id is ever resolved.
 *   - No display-name joins: IDs only, so no second read authority is
 *     duplicated and no fan-out is possible.
 *
 * Grain: exactly one row per `inventory_stock_movements` row in scope.
 * Identity: the movement id, published as `stockMovementId` (the only
 * rename). `quantity` is the row-level authoritative movement quantity —
 * never summed across items or UOMs, never converted, never netted.
 * `uomId` is the CR-BE-MAT-01 UOM snapshot at movement time (nullable on
 * historical rows) and stays a snapshot here — never a conversion input.
 * `performedByUserId` is the persisted movement actor — "Performed By",
 * nothing else: never a receiver, user, consumer, requester, approver or
 * executor relabeling.
 */

export type StockMovementRegisterFilters = {
  /** Explicit Building; access-asserted. Omitted = authorized rollup. */
  buildingId?: string;
  /** Structural equality over the movement's own persisted warehouse id. */
  warehouseId?: string;
  /** Structural equality over the movement's own persisted item id. */
  itemId?: string;
  /** Native `movement_type` value, verbatim vocabulary (STOCK_IN | STOCK_OUT). */
  movementType?: string;
  /** Strict YYYY-MM-DD; normalized to the inclusive whole-day window start. */
  dateFrom?: string;
  /** Strict YYYY-MM-DD; the whole UTC day is included via the next-day exclusive end. */
  dateTo?: string;
  /** Structural equality over the persisted movement actor id. */
  performedByUserId?: string;
  /**
   * The owning domain's own reference-filter semantics over the movement's
   * persisted generic `reference` text (case-insensitive substring, as in
   * the movements repository list) — never a cross-table search and never
   * resolved against any source domain.
   */
  reference?: string;
};

/** One flat register row. Every value is a persisted movement fact. */
export type PublicStockMovementRegisterRow = {
  /** `inventory_stock_movements.id` — the row identity (the only rename). */
  stockMovementId: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  /** Native direction/type discriminator: STOCK_IN | STOCK_OUT, verbatim. */
  movementType: string;
  /**
   * Native movement quantity, verbatim (`quantity`, NUMERIC NOT NULL,
   * schema-checked > 0). A per-row quantity fact only: never summed across
   * items or UOMs by this read model, never converted, never netted,
   * never valued.
   */
  quantity: number;
  /**
   * UOM snapshot at movement time (CR-BE-MAT-01, migration 0266): stable
   * `units_of_measure` id, NULL on historical rows. Snapshot semantics
   * preserved — no conversion, no fallback resolution here.
   */
  uomId: string | null;
  /** Business period authority (TIMESTAMPTZ, ISO-8601 published). */
  movementDate: string;
  /** Persisted generic reference text, verbatim; never reinterpreted. */
  reference: string | null;
  /** Persisted generic source text, verbatim; never reinterpreted. */
  source: string | null;
  /** The persisted movement actor — "Performed By", nothing else. */
  performedByUserId: string;
  notes: string | null;
  /**
   * Persisted HISTORICAL post-movement snapshot of quantity on hand,
   * recorded when this movement posted. Never a current balance.
   */
  resultingQuantityOnHand: number;
  /**
   * Persisted HISTORICAL post-movement snapshot of available quantity,
   * recorded when this movement posted. Never a current balance.
   */
  resultingAvailableQuantity: number;
  /** Audit fact. The table has no updated-at column; movements are immutable. */
  createdAt: string;
};

export type PublicStockMovementRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the scope resolution. */
  buildingScope: string[];
  /**
   * The accepted strict YYYY-MM-DD filter values, preserved as given.
   * The query itself applies the normalized half-open UTC window over
   * `movement_date` produced by `stockMovementRegisterRange` — start of
   * `dateFrom` (inclusive) to start of the day AFTER `dateTo` (exclusive),
   * so the whole `dateTo` calendar day is included.
   */
  dateFrom: string | null;
  dateTo: string | null;
  /** The evaluation instant. */
  asOf: string;
  rows: PublicStockMovementRegisterRow[];
};

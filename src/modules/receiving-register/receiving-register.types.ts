/**
 * R11 PART 01 — Receiving Register read contract types.
 *
 * READ MODEL ONLY. One flat row per authoritative `receivings` record
 * (BE-17G, extended by CR-BE-MAT-01 PART 01/04), prepared for Reporting
 * consumption by the RECEIVING_REGISTER dataset in a later R11 PART. This
 * PART deliberately registers nothing: the Reporting dataset enum stays at
 * 18 until the adapter PART lands.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no receiving entity, lifecycle status, or persistence.
 *   - It performs no business calculation and no inference: every status,
 *     type, quantity, timestamp and actor is the authoritative value
 *     verbatim from the receivings row.
 *   - NO PURCHASE ORDER LINKAGE. There is no authoritative historical
 *     receiving → purchase_order / purchase_order_line binding in the
 *     schema, so none is derived here — not from vendor, readiness, item,
 *     quantity, material request, service request, timestamp, and not from
 *     the current live PO. The register stays request-anchored: the
 *     persisted request lineage (purchaseRequestId / serviceRequestId /
 *     materialRequestId) is the only procurement context exposed.
 *   - NO MONETARY AUTHORITY. Receiving is a quantity / operational receipt
 *     fact: no price, amount, cost, value, currency, valuation or COGS
 *     field exists on this contract.
 *   - No display-name joins: IDs only, so no second read authority is
 *     duplicated and no fan-out is possible.
 *
 * Grain: exactly one row per `receivings` row in scope. Identity: the
 * receiving id. `uomId` is the CR-BE-MAT-01 PART 04 UOM snapshot at
 * receipt time (nullable on historical rows and service receivings) and
 * stays a snapshot here — never a conversion input. `stockMovementId` is
 * copied verbatim as the receiving-associated STOCK_IN movement reference;
 * the movement itself is a different grain and belongs to a different
 * register.
 */

export type ReceivingRegisterFilters = {
  /** Explicit Building; access-asserted. Omitted = authorized rollup. */
  buildingId?: string;
  /** Native `receivings.receiving_type` value, verbatim vocabulary. */
  receivingType?: string;
  /** Native `receivings.status` value, verbatim vocabulary. */
  status?: string;
  vendorId?: string;
  purchaseRequestId?: string;
  serviceRequestId?: string;
  /** Native optional MATERIAL-line binding (CR-BE-MAT-01 PART 01). */
  materialRequestId?: string;
  /** ISO date or datetime; half-open window over `received_at`. */
  dateFrom?: string;
  /** ISO date or datetime; date-only values include the whole UTC day. */
  dateTo?: string;
};

/** One flat register row. Every status/type is verbatim; every link nullable. */
export type PublicReceivingRegisterRow = {
  /** `receivings.id` — the row identity. */
  receivingId: string;
  clientId: string;
  buildingId: string;
  /** Native discriminator: PURCHASE_REQUEST | SERVICE_REQUEST. */
  requestType: string;
  /** Persisted request lineage — exactly one is non-null (schema CHECK). */
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  /** Optional MATERIAL-request line binding; null on legacy/service rows. */
  materialRequestId: string | null;
  vendorId: string;
  /** Native discriminator: MATERIAL | SERVICE. */
  receivingType: string;
  /** Inventory item reference (MATERIAL receivings); nullable. */
  itemId: string | null;
  warehouseId: string | null;
  /**
   * Native received quantity, verbatim (`receivings.quantity`, nullable on
   * legacy rows). A quantity fact only: never summed across items or UOMs
   * by this read model, never valued.
   */
  quantity: number | null;
  /**
   * UOM snapshot at receipt time (CR-BE-MAT-01 PART 04): stable
   * `units_of_measure` id, NULL on historical rows and service
   * receivings. Snapshot semantics preserved — no conversion, no fallback
   * resolution here.
   */
  uomId: string | null;
  /**
   * The receiving-associated `inventory_stock_movements` STOCK_IN id for
   * material receipts (BE-16 reuse), copied verbatim; null for service
   * receivings. The movement row is NOT expanded here — different grain.
   */
  stockMovementId: string | null;
  /** The persisted receiving actor — "Received By", nothing else. */
  receivedByUserId: string;
  /** Business period authority (ISO-8601). */
  receivedAt: string;
  /** Native lifecycle status: RECEIVED | FINALIZED. */
  status: string;
  notes: string | null;
};

export type PublicReceivingRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the scope resolution. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** The evaluation instant. */
  asOf: string;
  rows: PublicReceivingRegisterRow[];
};

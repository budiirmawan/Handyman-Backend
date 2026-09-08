/**
 * BE-17G — Receiving domain types.
 *
 * Records the receipt of goods/services for an approved Procurement request
 * (BE-17A Purchase Request or BE-17C Service Request) from a selected Vendor.
 * It must reference valid procurement readiness context (a READY
 * `purchase_order_readiness` for the request + vendor).
 *
 * Material receiving reuses the BE-16 stock-in logic (STOCK_IN movement) — no
 * duplicate inventory movement logic. Service receiving records acceptance
 * without stock movement. No invoice, payment, tax, accounting, or 3-way
 * matching.
 */
export const RECEIVING_REQUEST_TYPES = [
  'PURCHASE_REQUEST',
  'SERVICE_REQUEST',
] as const;
export type ReceivingRequestType = (typeof RECEIVING_REQUEST_TYPES)[number];

export const RECEIVING_TYPES = ['MATERIAL', 'SERVICE'] as const;
export type ReceivingType = (typeof RECEIVING_TYPES)[number];

export const RECEIVING_STATUSES = ['RECEIVED', 'FINALIZED'] as const;
export type ReceivingStatus = (typeof RECEIVING_STATUSES)[number];

export function isReceivingRequestType(
  value: unknown,
): value is ReceivingRequestType {
  return (
    typeof value === 'string' &&
    (RECEIVING_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

export function isReceivingType(value: unknown): value is ReceivingType {
  return (
    typeof value === 'string' && (RECEIVING_TYPES as readonly string[]).includes(value)
  );
}

export function isReceivingStatus(value: unknown): value is ReceivingStatus {
  return (
    typeof value === 'string' &&
    (RECEIVING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ReceivingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: ReceivingRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  materialRequestId: string | null;
  vendorId: string;
  receivingType: ReceivingType;
  itemId: string | null;
  warehouseId: string | null;
  quantity: number | null;
  /**
   * CR-BE-MAT-01 PART 04 — UOM snapshot at receipt time (stable
   * `units_of_measure` id; MR-line UOM when bound, else item UOM). NULL on
   * historical rows and service receivings; fall back to the item's current
   * UOM for legacy reads.
   */
  uomId: string | null;
  stockMovementId: string | null;
  receivedByUserId: string;
  receivedAt: Date;
  status: ReceivingStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicReceiving = Omit<
  ReceivingRecord,
  'receivedAt' | 'createdAt' | 'updatedAt'
> & {
  requestId: string;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
  vendor?: {
    id: string;
    vendorCode: string;
    vendorName: string;
    status: string;
  } | null;
  item?: {
    id: string;
    code: string;
    name: string;
    itemType: string;
  } | null;
  warehouse?: {
    id: string;
    code: string;
    name: string;
    buildingId: string;
  } | null;
};

/** Input supplied when recording a receiving. */
export type CreateReceivingInput = {
  requestType: ReceivingRequestType;
  requestId: string;
  vendorId: string;
  receivingType: ReceivingType;
  /**
   * CR-BE-MAT-01 PART 01 — optional stable reference to the BE-17B Material
   * Request line being fulfilled. MATERIAL receiving only; when present the
   * service enforces line identity and the cumulative over-receipt guard.
   */
  materialRequestId?: string | null;
  itemId?: string | null;
  warehouseId?: string | null;
  quantity?: number | null;
  /**
   * PART 04 — optional explicit UOM. Must match the resolved MR-line / item
   * UOM exactly; there is no conversion authority, so a differing UOM is
   * rejected deterministically.
   */
  uomId?: string | null;
  notes?: string;
};

/** Fully-resolved receiving data ready for persistence. */
export type NewReceiving = {
  clientId: string;
  buildingId: string;
  requestType: ReceivingRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  materialRequestId: string | null;
  vendorId: string;
  receivingType: ReceivingType;
  itemId: string | null;
  warehouseId: string | null;
  quantity: number | null;
  uomId: string | null;
  stockMovementId: string | null;
  receivedByUserId: string;
  receivedAt: Date;
  status: ReceivingStatus;
  notes: string | null;
};

/** Partial update input (PATCH /receivings/:id). */
export type UpdateReceivingInput = {
  notes?: string | null;
};

/** List filters. */
export type ReceivingFilters = {
  status?: ReceivingStatus;
  receivingType?: ReceivingType;
};

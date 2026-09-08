/**
 * BE-17B — Material Request domain types.
 *
 * A Material Request is a lightweight line item on a Purchase Request (BE-17A)
 * that asks for a quantity of a BE-16 Inventory Item. It carries no approval,
 * vendor selection, purchase order, receiving, or payment/accounting concerns
 * — those arrive in later BE-17 PARTs.
 *
 * It reuses existing foundations and does NOT duplicate the item master:
 * `item_id` references `inventory_items` (BE-16A), and `uom_id` is derived
 * from (and validated against) the item's UOM. `clientId` and `buildingId`
 * are derived authoritatively from the Purchase Request (never from the
 * caller), so isolation stays consistent with BE-02. `warehouseId` is optional
 * and, when provided, must resolve to the same Building as the Purchase
 * Request.
 */
export const MATERIAL_REQUEST_STATUSES = ['OPEN', 'APPROVED', 'CANCELLED'] as const;

export type MaterialRequestStatus = (typeof MATERIAL_REQUEST_STATUSES)[number];

export function isMaterialRequestStatus(
  value: unknown,
): value is MaterialRequestStatus {
  return (
    typeof value === 'string' &&
    (MATERIAL_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type MaterialRequestRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  itemId: string;
  warehouseId: string | null;
  quantity: number;
  /**
   * CR-BE-MAT-01 PART 02 — authoritative approved quantity. NULL until the
   * line is APPROVED (historical rows stay NULL); downstream fulfilment falls
   * back to the requested `quantity` when NULL.
   */
  approvedQuantity: number | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  uomId: string | null;
  requiredDate: Date | null;
  notes: string | null;
  status: MaterialRequestStatus;
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicMaterialRequest = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  itemId: string;
  warehouseId: string | null;
  quantity: number;
  approvedQuantity: number | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  /** Cumulative valid received quantity (detail reads only). */
  receivedQuantity?: number;
  /** Derived: (approvedQuantity ?? quantity) - receivedQuantity (detail reads only). */
  remainingQuantity?: number;
  uomId: string | null;
  requiredDate: string | null;
  notes: string | null;
  status: MaterialRequestStatus;
  requestedByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Optional resolved context when available. */
  purchaseRequest?: {
    id: string;
    requestNumber: string;
    title: string;
    status: string;
  } | null;
  item?: {
    id: string;
    code: string;
    name: string;
    itemType: string;
    uomId: string | null;
  } | null;
  warehouse?: {
    id: string;
    code: string;
    name: string;
    buildingId: string;
  } | null;
};

/** Input supplied by the API consumer when creating a Material Request. */
export type CreateMaterialRequestInput = {
  purchaseRequestId: string;
  itemId: string;
  quantity: number;
  uomId?: string | null;
  warehouseId?: string | null;
  requiredDate?: string | null;
  notes?: string;
  requestedByUserId: string;
};

/** Fully-resolved Material Request data ready for persistence. */
export type NewMaterialRequest = {
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  itemId: string;
  warehouseId: string | null;
  quantity: number;
  uomId: string | null;
  requiredDate: Date | null;
  notes: string | null;
  requestedByUserId: string;
};

/** Partial update input (PATCH /material-requests/:id). */
export type UpdateMaterialRequestInput = {
  quantity?: number;
  uomId?: string | null;
  warehouseId?: string | null;
  requiredDate?: string | null;
  notes?: string | null;
};

/** List filters for building/item/purchase-request scoped listings. */
export type MaterialRequestFilters = {
  status?: MaterialRequestStatus;
  purchaseRequestId?: string;
  itemId?: string;
};

/**
 * BE-16D — Stock In / Out movement types.
 *
 * Append-only ledger. Each movement updates BE-16C Stock Balance atomically.
 * Preserves client/building/warehouse context, performed_by, reference/source.
 */

export const STOCK_MOVEMENT_TYPES = ['STOCK_IN', 'STOCK_OUT'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export function isStockMovementType(v: unknown): v is StockMovementType {
  return typeof v === 'string' && (STOCK_MOVEMENT_TYPES as readonly string[]).includes(v);
}

export type StockMovementRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  movementType: StockMovementType;
  quantity: number;
  /**
   * CR-BE-MAT-01 PART 04 — UOM snapshot: the item's UOM at movement time
   * (stable `units_of_measure` id). NULL on historical rows and items
   * without a UOM; fall back to the item's current UOM for legacy reads.
   */
  uomId: string | null;
  movementDate: Date;
  reference: string | null;
  source: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
  createdAt: Date;
};

export type PublicStockMovement = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  movementType: StockMovementType;
  quantity: number;
  uomId: string | null;
  movementDate: string;
  reference: string | null;
  source: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
  createdAt: string;
  warehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  item?: { id: string; code: string; name: string; itemType: string } | null;
  // Resolved resulting balance
  resultingBalance?: {
    quantityOnHand: number;
    reservedQuantity: number;
    availableQuantity: number;
  } | null;
};

export type CreateStockMovementInput = {
  warehouseId: string;
  itemId: string;
  movementType: StockMovementType;
  quantity: number;
  /**
   * Internal transaction option for a controlled reservation-backed STOCK_OUT.
   * When set, it must equal `quantity`; the existing balance decreases both
   * on-hand and reserved quantities so available stock is not double-counted.
   * Public movement routes never accept this field.
   */
  reservedQuantityToConsume?: number;
  movementDate?: string; // ISO
  reference?: string;
  source?: string;
  notes?: string;
  performedByUserId: string;
};

export type NewStockMovement = {
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  movementType: StockMovementType;
  quantity: number;
  /** PART 04 — UOM snapshot at movement time (item's UOM; null when none). */
  uomId: string | null;
  movementDate: Date;
  reference: string | null;
  source: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
};

export type StockMovementFilters = {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  movementType?: StockMovementType;
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
  performedByUserId?: string;
  search?: string;
};

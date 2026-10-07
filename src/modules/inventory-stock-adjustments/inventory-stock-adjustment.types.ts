/**
 * BE-16F — Stock Adjustment domain types.
 * Types: INCREASE, DECREASE, SET_BALANCE
 */

export const ADJUSTMENT_TYPES = ['INCREASE', 'DECREASE', 'SET_BALANCE'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export function isAdjustmentType(v: unknown): v is AdjustmentType {
  return typeof v === 'string' && (ADJUSTMENT_TYPES as readonly string[]).includes(v);
}

export type StockAdjustmentRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  adjustmentType: AdjustmentType;
  quantity: number;
  reason: string;
  adjustedAt: Date;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
  createdAt: Date;
};

export type PublicStockAdjustment = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  adjustmentType: AdjustmentType;
  quantity: number;
  reason: string;
  adjustedAt: string;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
  createdAt: string;
  warehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  item?: { id: string; code: string; name: string; itemType: string } | null;
  resultingBalance?: { quantityOnHand: number; reservedQuantity: number; availableQuantity: number } | null;
};

export type CreateAdjustmentInput = {
  warehouseId: string;
  itemId: string;
  adjustmentType: AdjustmentType;
  quantity: number;
  reason: string;
  adjustedAt?: string;
  reference?: string;
  notes?: string;
  performedByUserId: string;
};

export type NewAdjustment = {
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  adjustmentType: AdjustmentType;
  quantity: number;
  reason: string;
  adjustedAt: Date;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
};

export type StockAdjustmentFilters = {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  adjustmentType?: AdjustmentType;
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
  performedByUserId?: string;
  reason?: string;
};

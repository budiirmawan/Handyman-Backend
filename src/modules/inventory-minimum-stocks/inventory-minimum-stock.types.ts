/**
 * BE-16G — Minimum Stock threshold domain types.
 *
 * One active threshold per Item + Warehouse.
 * Readiness resolved against BE-16C available stock:
 *   available < minimum => LOW_STOCK else OK.
 */

export const MINIMUM_STOCK_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MinimumStockStatus = (typeof MINIMUM_STOCK_STATUSES)[number];

export function isMinimumStockStatus(v: unknown): v is MinimumStockStatus {
  return typeof v === 'string' && (MINIMUM_STOCK_STATUSES as readonly string[]).includes(v);
}

export const STOCK_READINESS = ['OK', 'LOW_STOCK', 'UNKNOWN'] as const;
export type StockReadiness = (typeof STOCK_READINESS)[number];

export type MinimumStockRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  minimumQuantity: number;
  status: MinimumStockStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicMinimumStock = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  minimumQuantity: number;
  status: MinimumStockStatus;
  createdAt: string;
  updatedAt: string;
  warehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  item?: { id: string; code: string; name: string; itemType: string } | null;
  // Resolved current balance and readiness
  currentBalance?: {
    quantityOnHand: number;
    reservedQuantity: number;
    availableQuantity: number;
  } | null;
  readiness: StockReadiness;
};

export type CreateMinimumStockInput = {
  warehouseId: string;
  itemId: string;
  minimumQuantity: number;
  status?: MinimumStockStatus;
};

export type NewMinimumStock = {
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  minimumQuantity: number;
  status: MinimumStockStatus;
};

export type UpdateMinimumStockInput = {
  minimumQuantity?: number;
  status?: MinimumStockStatus;
};

export type MinimumStockFilters = {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  status?: MinimumStockStatus;
  readiness?: StockReadiness;
};

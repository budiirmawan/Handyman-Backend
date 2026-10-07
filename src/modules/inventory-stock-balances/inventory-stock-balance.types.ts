/**
 * BE-16C — Stock Balance domain types.
 *
 * One balance per Item + Warehouse/Store.
 * client_id, building_id denormalized from warehouse for isolation.
 * quantity_on_hand >=0, reserved_quantity >=0, reserved <= on_hand.
 * available_quantity is GENERATED ALWAYS AS (on_hand - reserved) STORED — guaranteed consistent.
 * No movement logic here — BE-16D onward.
 */

export type InventoryStockBalanceRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  quantityOnHand: number;
  reservedQuantity: number;
  availableQuantity: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicInventoryStockBalance = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  quantityOnHand: number;
  reservedQuantity: number;
  availableQuantity: number;
  createdAt: string;
  updatedAt: string;
  // Enriched contexts
  warehouse?: {
    id: string;
    code: string;
    name: string;
    buildingId: string;
  } | null;
  item?: {
    id: string;
    code: string;
    name: string;
    itemType: string;
    uomId: string | null;
  } | null;
};

export type CreateStockBalanceInput = {
  warehouseId: string;
  itemId: string;
  quantityOnHand?: number;
  reservedQuantity?: number;
};

export type NewStockBalance = {
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  quantityOnHand: number;
  reservedQuantity: number;
};

export type StockBalanceFilters = {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
};

export type StockBalanceListFilters = {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  // search on item code/name or warehouse code/name if needed
  search?: string;
};

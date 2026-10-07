/**
 * BE-16E — Stock Transfer domain types.
 *
 * Transfer quantity of one Item from source warehouse to destination warehouse.
 * Atomic: source decrease, destination increase, transfer record, two stock movements.
 */

export const TRANSFER_STATUSES = ['COMPLETED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export function isTransferStatus(v: unknown): v is TransferStatus {
  return typeof v === 'string' && (TRANSFER_STATUSES as readonly string[]).includes(v);
}

export type StockTransferRecord = {
  id: string;
  clientId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceBuildingId: string;
  destinationBuildingId: string;
  itemId: string;
  quantity: number;
  transferDate: Date;
  status: TransferStatus;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingSourceOnHand: number;
  resultingSourceAvailable: number;
  resultingDestinationOnHand: number;
  resultingDestinationAvailable: number;
  createdAt: Date;
};

export type PublicStockTransfer = {
  id: string;
  clientId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceBuildingId: string;
  destinationBuildingId: string;
  itemId: string;
  quantity: number;
  transferDate: string;
  status: TransferStatus;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingSourceOnHand: number;
  resultingSourceAvailable: number;
  resultingDestinationOnHand: number;
  resultingDestinationAvailable: number;
  createdAt: string;
  sourceWarehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  destinationWarehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  item?: { id: string; code: string; name: string; itemType: string } | null;
  // Resulting balances
  resultingSourceBalance?: { quantityOnHand: number; reservedQuantity: number; availableQuantity: number } | null;
  resultingDestinationBalance?: { quantityOnHand: number; reservedQuantity: number; availableQuantity: number } | null;
};

export type CreateTransferInput = {
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  itemId: string;
  quantity: number;
  transferDate?: string;
  reference?: string;
  notes?: string;
  performedByUserId: string;
};

export type NewTransfer = {
  clientId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceBuildingId: string;
  destinationBuildingId: string;
  itemId: string;
  quantity: number;
  transferDate: Date;
  status: TransferStatus;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingSourceOnHand: number;
  resultingSourceAvailable: number;
  resultingDestinationOnHand: number;
  resultingDestinationAvailable: number;
};

export type StockTransferFilters = {
  clientId?: string;
  buildingId?: string; // matches source or destination building
  sourceWarehouseId?: string;
  destinationWarehouseId?: string;
  warehouseId?: string; // either source or dest
  itemId?: string;
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
  performedByUserId?: string;
  status?: TransferStatus;
};

/**
 * BE-16I / CR-BE-INV-CONTROL-01 PART 02 — Work Order Material Usage.
 *
 * Usage remains the append-only issue/use authority. New controlled rows are
 * attributed to an approved Material Request; historical rows may remain
 * unlinked for compatibility.
 */

export type WorkOrderMaterialUsageRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  materialRequestId: string | null;
  reservationId: string | null;
  quantity: number;
  /** UOM snapshot at issue/use time. */
  uomId: string | null;
  /** Operational cost snapshot at issue/use time. */
  unitCost: number | null;
  totalCost: number | null;
  currency: string | null;
  costSource: string | null;
  costReference: string | null;
  stockMovementId: string | null;
  usedByUserId: string;
  usedAt: Date;
  reference: string | null;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
  createdAt: Date;
};

export type PublicWorkOrderMaterialUsage = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  materialRequestId: string | null;
  reservationId: string | null;
  quantity: number;
  uomId: string | null;
  unitCost: number | null;
  totalCost: number | null;
  currency: string | null;
  costSource: string | null;
  costReference: string | null;
  stockMovementId: string | null;
  usedByUserId: string;
  usedAt: string;
  reference: string | null;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
  createdAt: string;
  workOrder?: { id: string; workOrderNumber: string; title: string; status: string } | null;
  warehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  item?: { id: string; code: string; name: string; itemType: string } | null;
  resultingBalance?: { quantityOnHand: number; reservedQuantity: number; availableQuantity: number } | null;
};

export type CreateWorkOrderMaterialUsageInput = {
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  quantity: number;
  /** Existing approved demand source resolved from the Work Order binding. */
  materialRequestId?: string;
  /** Optional ACTIVE allocation to consume atomically. */
  reservationId?: string;
  /** Optional explicit UOM; must match the item UOM (no conversion). */
  uomId?: string;
  /** Optional operational unit cost snapshot (>= 0). */
  unitCost?: number;
  /** ISO 4217 code; requires unitCost. */
  currency?: string;
  costSource?: string;
  costReference?: string;
  usedAt?: string;
  reference?: string;
  notes?: string;
  usedByUserId: string;
};

export type NewWorkOrderMaterialUsage = {
  clientId: string;
  buildingId: string;
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  materialRequestId: string;
  reservationId: string | null;
  quantity: number;
  /** UOM snapshot at issue/use time. */
  uomId: string | null;
  /** Operational cost snapshot (total_cost is DB-generated). */
  unitCost: number | null;
  currency: string | null;
  costSource: string | null;
  costReference: string | null;
  stockMovementId: string | null;
  usedByUserId: string;
  usedAt: Date;
  reference: string | null;
  notes: string | null;
  resultingQuantityOnHand: number;
  resultingAvailableQuantity: number;
};

export type WorkOrderMaterialUsageFilters = {
  clientId?: string;
  buildingId?: string;
  workOrderId?: string;
  warehouseId?: string;
  itemId?: string;
  materialRequestId?: string;
  reservationId?: string;
  dateFrom?: string;
  dateTo?: string;
  usedByUserId?: string;
  reference?: string;
};

/** Deterministic Work Order material-cost aggregation. */
export type WorkOrderMaterialCostSummary = {
  workOrderId: string;
  usageCount: number;
  costedUsageCount: number;
  totalMaterialCost: number;
  byCurrency: { currency: string | null; totalCost: number }[];
};

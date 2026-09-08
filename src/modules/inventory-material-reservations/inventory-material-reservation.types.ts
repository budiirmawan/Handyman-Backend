/**
 * CR-BE-INV-CONTROL-01 Material Reservation domain types.
 *
 * A reservation is an allocation against an existing Material Request. It is
 * not an approved-quantity or stock-balance authority. The source demand stays
 * on `material_requests`; current stock stays on `inventory_stock_balances`.
 */

export const MATERIAL_RESERVATION_STATUSES = [
  'ACTIVE',
  'RELEASED',
  'CANCELLED',
  'CONSUMED',
] as const;

export type MaterialReservationStatus =
  (typeof MATERIAL_RESERVATION_STATUSES)[number];

export function isMaterialReservationStatus(
  value: unknown,
): value is MaterialReservationStatus {
  return (
    typeof value === 'string' &&
    (MATERIAL_RESERVATION_STATUSES as readonly string[]).includes(value)
  );
}

export type MaterialReservationRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  materialRequestId: string;
  warehouseId: string;
  itemId: string;
  uomId: string | null;
  /** Original allocation; never becomes a second demand authority. */
  reservedQuantity: number;
  consumedQuantity: number;
  remainingQuantity: number;
  status: MaterialReservationStatus;
  createdByUserId: string;
  releasedByUserId: string | null;
  cancelledByUserId: string | null;
  consumedByUserId: string | null;
  notes: string | null;
  createdAt: Date;
  releasedAt: Date | null;
  cancelledAt: Date | null;
  consumedAt: Date | null;
  updatedAt: Date;
};

export type MaterialReservationDemand = {
  authorizedDemand: number;
  cumulativeIssued: number;
  activeReserved: number;
  remainingDemand: number;
  reservableDemand: number;
};

export type PublicMaterialReservation = {
  id: string;
  clientId: string;
  buildingId: string;
  materialRequestId: string;
  warehouseId: string;
  itemId: string;
  uomId: string | null;
  reservedQuantity: number;
  consumedQuantity: number;
  remainingQuantity: number;
  status: MaterialReservationStatus;
  createdByUserId: string;
  releasedByUserId: string | null;
  cancelledByUserId: string | null;
  consumedByUserId: string | null;
  notes: string | null;
  createdAt: string;
  releasedAt: string | null;
  cancelledAt: string | null;
  consumedAt: string | null;
  updatedAt: string;
  /** Derived at command/read time; never persisted as an authority. */
  demand?: MaterialReservationDemand;
  materialRequest?: {
    id: string;
    itemId: string;
    warehouseId: string | null;
    quantity: number;
    approvedQuantity: number | null;
    status: string;
  } | null;
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

export type CreateMaterialReservationInput = {
  materialRequestId: string;
  warehouseId: string;
  /** Optional assertion; the item is derived from the Material Request. */
  itemId?: string;
  /** Optional assertion; the UOM is derived from the Item/MR relationship. */
  uomId?: string | null;
  quantity: number;
  notes?: string;
  createdByUserId: string;
};

export type NewMaterialReservation = {
  clientId: string;
  buildingId: string;
  materialRequestId: string;
  warehouseId: string;
  itemId: string;
  uomId: string | null;
  reservedQuantity: number;
  status: 'ACTIVE';
  createdByUserId: string;
  notes: string | null;
};

export type MaterialReservationFilters = {
  materialRequestId: string;
  status?: MaterialReservationStatus;
};

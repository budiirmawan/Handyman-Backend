import type { MaterialRequestStatus } from '../material-requests/material-request.types';
import type { MaterialReservationStatus } from '../inventory-material-reservations/inventory-material-reservation.types';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — mobile field material request DTOs.
 *
 * The record IS a canonical BE-17B `material_requests` row under the Work
 * Order's field Purchase Request (PART 00). This module adds no second
 * material domain — only a field-shaped read model and a Work-Order-bound
 * command surface.
 */

/** Strict CREATE body — everything else is server-derived and rejected. */
export const MOBILE_MATERIAL_REQUEST_BODY_FIELDS = [
  'itemId',
  'quantity',
  'uomId',
  'notes',
] as const;

/** Client-supplied authority fields rejected with an explicit reason. */
export const MOBILE_MATERIAL_REQUEST_DERIVED_FIELDS: Readonly<Record<string, string>> = {
  purchaseRequestId: 'purchaseRequestId is server-derived from the Work Order.',
  workOrderId: 'workOrderId comes from the route path.',
  clientId: 'clientId is derived from the Work Order.',
  buildingId: 'buildingId is derived from the Work Order.',
  requestedByUserId: 'requestedByUserId is the authenticated actor.',
  status: 'status is server-managed.',
  approvedQuantity: 'approvedQuantity is management approval authority.',
  approvedByUserId: 'approvedByUserId is management approval authority.',
  approvedAt: 'approvedAt is management approval authority.',
  warehouseId: 'warehouseId is not chosen at field request time.',
  reservedQuantity: 'reservedQuantity is not a request field.',
  issuedQuantity: 'issuedQuantity is not a request field.',
  unitCost: 'unitCost is not a field request concern.',
  currency: 'currency is not a field request concern.',
  requiredDate: 'requiredDate is not accepted by the field command.',
};

export type MobileMaterialRequestInput = {
  itemId: string;
  quantity: number;
  /** Must equal the item's canonical UOM (null only for a UOM-less item). */
  uomId: string | null;
  notes?: string;
};

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 02 — fulfillment awareness. Every value
 * is computed by the canonical demand arithmetic shared with issue control
 * (`inventoryMaterialReservationRepository` DEMAND_SELECT); nothing here is
 * derived client-side or in this module.
 *
 *   requestedQuantity        material_requests.quantity
 *   approvedQuantity         material_requests.approved_quantity (null until approved)
 *   activeReservedQuantity   SUM(remaining_quantity) of ACTIVE reservations
 *   cumulativeIssuedQuantity SUM(inventory_work_order_material_usages.quantity)
 *   remainingDemandQuantity  COALESCE(approved, requested) - cumulativeIssued
 *                            (issue cap; active reservations are NOT subtracted)
 *
 * NOT here: on-hand, available, global reserved, receiving remainingQuantity,
 * usedQuantity, acknowledgement, availableActions.
 */
export type MobileMaterialRequestFulfillment = {
  requestedQuantity: number;
  approvedQuantity: number | null;
  activeReservedQuantity: number;
  cumulativeIssuedQuantity: number;
  remainingDemandQuantity: number;
};

export type MobileMaterialWarehouseRef = { id: string; code: string; name: string } | null;

/** Canonical reservation row as the technician may see it. */
export type MobileMaterialReservation = {
  id: string;
  materialRequestId: string;
  warehouseId: string;
  warehouse: MobileMaterialWarehouseRef;
  reservedQuantity: number;
  consumedQuantity: number;
  remainingQuantity: number;
  status: MaterialReservationStatus;
  createdAt: string;
  updatedAt: string;
};

/** Canonical physical issue (= inventory_work_order_material_usages row). */
export type MobileMaterialIssue = {
  id: string;
  materialRequestId: string;
  reservationId: string | null;
  warehouseId: string;
  warehouse: MobileMaterialWarehouseRef;
  itemId: string;
  quantity: number;
  uomId: string | null;
  usedAt: string;
  usedByUserId: string;
  reference: string | null;
  notes: string | null;
  stockMovementId: string | null;
};

/** Field item discovery — identity + UOM only, never stock quantities. */
export type MobileMaterialItem = {
  itemId: string;
  code: string;
  name: string;
  itemType: string;
  uom: { id: string; code: string; name: string; symbol: string } | null;
};

/* CR-BE-RN11-MATERIAL-FIELD-01 PART 04 — CLOSED action vocabulary. */
export const MOBILE_WORK_ORDER_MATERIAL_AVAILABLE_ACTIONS = ['REQUEST_MATERIAL'] as const;
export type MobileWorkOrderMaterialAvailableAction =
  (typeof MOBILE_WORK_ORDER_MATERIAL_AVAILABLE_ACTIONS)[number];

export const MOBILE_MATERIAL_REQUEST_AVAILABLE_ACTIONS = [
  'CANCEL_MATERIAL_REQUEST',
  'RECORD_MATERIAL_USAGE',
] as const;
export type MobileMaterialRequestAvailableAction =
  (typeof MOBILE_MATERIAL_REQUEST_AVAILABLE_ACTIONS)[number];

/**
 * Field read model — canonical REQUEST facts + fulfillment awareness
 * (PART 02) + server-authoritative `availableActions` snapshot (PART 04). No receiving-based `remainingQuantity`, no used / returned /
 * available / on-hand quantities.
 */
export type MobileMaterialRequest = {
  id: string;
  workOrderId: string;
  purchaseRequestId: string;
  purchaseRequestNumber: string;
  item: { id: string; code: string; name: string; itemType: string };
  quantity: number;
  approvedQuantity: number | null;
  uomId: string | null;
  uom: { id: string; code: string; name: string; symbol: string } | null;
  requiredDate: string | null;
  notes: string | null;
  status: MaterialRequestStatus;
  requestedByUserId: string;
  createdAt: string;
  updatedAt: string;
  fulfillment: MobileMaterialRequestFulfillment;
  availableActions: MobileMaterialRequestAvailableAction[];
};

/** PART 04 — Work Order material context (LIST envelope). */
export type MobileWorkOrderMaterialContext = {
  workOrderId: string;
  availableActions: MobileWorkOrderMaterialAvailableAction[];
  materialRequests: MobileMaterialRequest[];
};

/** GET detail = list shape + reservation awareness + issue history. */
export type MobileMaterialRequestDetail = MobileMaterialRequest & {
  reservations: MobileMaterialReservation[];
  issues: MobileMaterialIssue[];
};

/* ------------------------------------------------------------------------ */
/* CR-BE-RN11-MATERIAL-FIELD-01 PART 03 — field material usage (issue)        */
/* ------------------------------------------------------------------------ */

/** Strict field USAGE body — everything else is server-derived and rejected. */
export const MOBILE_MATERIAL_USAGE_BODY_FIELDS = [
  'materialRequestId',
  'reservationId',
  'quantity',
  'notes',
] as const;

export const MOBILE_MATERIAL_USAGE_DERIVED_FIELDS: Readonly<Record<string, string>> = {
  workOrderId: 'workOrderId comes from the route path.',
  warehouseId: 'warehouseId is derived from the resolved reservation.',
  itemId: 'itemId is derived from the material request.',
  uomId: 'uomId is derived from the material request.',
  usedByUserId: 'usedByUserId is the authenticated actor.',
  usedAt: 'usedAt is the server timestamp.',
  clientId: 'clientId is derived from the Work Order.',
  buildingId: 'buildingId is derived from the Work Order.',
  unitCost: 'unitCost is not a field usage concern.',
  currency: 'currency is not a field usage concern.',
  costSource: 'costSource is not a field usage concern.',
  costReference: 'costReference is not a field usage concern.',
  reference: 'reference is not accepted by the field command.',
  stockMovementId: 'stockMovementId is generated by the stock ledger.',
  resultingQuantityOnHand: 'resultingQuantityOnHand is computed by the stock ledger.',
  resultingAvailableQuantity: 'resultingAvailableQuantity is computed by the stock ledger.',
  quantityOnHand: 'stock levels are not a command input.',
};

export type MobileMaterialUsageInput = {
  materialRequestId: string;
  reservationId?: string;
  quantity: number;
  notes?: string;
};

/** Field usage result = the canonical usage row projected as a `MobileMaterialIssue`. */
export type MobileMaterialUsageResult = {
  usage: MobileMaterialIssue;
};

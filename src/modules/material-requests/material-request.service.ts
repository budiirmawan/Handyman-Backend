import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { purchaseRequestRepository } from '../purchase-requests';
import { purchaseRequestNotFoundError } from '../purchase-requests/purchase-request.errors';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import {
  materialRequestActiveReservationError,
  materialRequestInvalidQuantityError,
  materialRequestItemClientMismatchError,
  materialRequestItemUomMismatchError,
  materialRequestNotFoundError,
  materialRequestNotOpenError,
  materialRequestPurchaseRequestNotOpenError,
  materialRequestWarehouseBuildingMismatchError,
  materialRequestWarehouseClientMismatchError,
} from './material-request.errors';
import { materialRequestRepository } from './material-request.repository';
import { inventoryMaterialReservationRepository } from '../inventory-material-reservations/inventory-material-reservation.repository';
import type {
  CreateMaterialRequestInput,
  MaterialRequestFilters,
  MaterialRequestRecord,
  NewMaterialRequest,
  PublicMaterialRequest,
  UpdateMaterialRequestInput,
} from './material-request.types';

export function toPublicMaterialRequest(
  record: MaterialRequestRecord,
): PublicMaterialRequest {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    purchaseRequestId: record.purchaseRequestId,
    itemId: record.itemId,
    warehouseId: record.warehouseId,
    quantity: record.quantity,
    approvedQuantity: record.approvedQuantity,
    approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
    approvedByUserId: record.approvedByUserId,
    uomId: record.uomId,
    requiredDate: record.requiredDate
      ? record.requiredDate.toISOString()
      : null,
    notes: record.notes,
    status: record.status,
    requestedByUserId: record.requestedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    purchaseRequest: null,
    item: null,
    warehouse: null,
  };
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  return new Date(value);
}

/**
 * Resolves the UOM for a Material Request from the Item Master. The item's
 * `uomId` is the single authority; a caller-supplied `uomId` must match it
 * exactly (or be omitted). An item without a UOM yields `null`.
 */
function resolveUomId(
  itemUomId: string | null,
  suppliedUomId: string | null | undefined,
): string | null {
  if (suppliedUomId !== undefined && suppliedUomId !== itemUomId) {
    throw materialRequestItemUomMismatchError();
  }
  return itemUomId;
}

/**
 * Creates a Material Request line item on a Purchase Request.
 *
 * `client_id` and `building_id` are derived from the Purchase Request (never
 * from the caller). Validation order (pinned by tests):
 *   1. unknown Purchase Request           → 404 PURCHASE_REQUEST_NOT_FOUND
 *   2. Purchase Request not OPEN          → 400 MATERIAL_REQUEST_PURCHASE_REQUEST_NOT_OPEN
 *   3. unknown Item                       → 404 INVENTORY_ITEM_NOT_FOUND
 *   4. Item of a different Client         → 400 MATERIAL_REQUEST_ITEM_CLIENT_MISMATCH
 *   5. warehouse provided & unknown       → 404 INVENTORY_WAREHOUSE_NOT_FOUND
 *   6. warehouse of a different Client    → 400 MATERIAL_REQUEST_WAREHOUSE_CLIENT_MISMATCH
 *   7. warehouse of a different Building  → 400 MATERIAL_REQUEST_WAREHOUSE_BUILDING_MISMATCH
 *   8. UOM must match the item's UOM      → 400 MATERIAL_REQUEST_ITEM_UOM_MISMATCH
 */
export async function createMaterialRequest(
  input: CreateMaterialRequestInput,
  executor?: PoolClient,
): Promise<PublicMaterialRequest> {
  if (!input.quantity || input.quantity <= 0) {
    throw materialRequestInvalidQuantityError();
  }

  // The Purchase Request may have been created in the caller's still-open
  // transaction (PART 00 Work-Order field parent), so read it on the executor.
  const purchaseRequest = await purchaseRequestRepository.findById(
    input.purchaseRequestId,
    executor ?? null,
  );
  if (!purchaseRequest) {
    throw purchaseRequestNotFoundError();
  }
  if (purchaseRequest.status !== 'OPEN') {
    throw materialRequestPurchaseRequestNotOpenError();
  }

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) {
    throw inventoryItemNotFoundError();
  }
  if (item.clientId !== purchaseRequest.clientId) {
    throw materialRequestItemClientMismatchError();
  }

  let warehouseId: string | null = null;
  if (input.warehouseId !== undefined && input.warehouseId !== null) {
    const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
    if (!warehouse) {
      throw inventoryWarehouseNotFoundError();
    }
    if (warehouse.clientId !== purchaseRequest.clientId) {
      throw materialRequestWarehouseClientMismatchError();
    }
    if (warehouse.buildingId !== purchaseRequest.buildingId) {
      throw materialRequestWarehouseBuildingMismatchError();
    }
    warehouseId = warehouse.id;
  }

  const uomId = resolveUomId(item.uomId, input.uomId);

  const newMaterialRequest: NewMaterialRequest = {
    clientId: purchaseRequest.clientId,
    buildingId: purchaseRequest.buildingId,
    purchaseRequestId: purchaseRequest.id,
    itemId: item.id,
    warehouseId,
    quantity: input.quantity,
    uomId,
    requiredDate: toDateOrNull(input.requiredDate),
    notes: input.notes?.trim() || null,
    requestedByUserId: input.requestedByUserId,
  };

  const record = await materialRequestRepository.create(newMaterialRequest, executor);
  return toPublicMaterialRequest(record);
}

export async function getMaterialRequestById(
  id: string,
): Promise<PublicMaterialRequest> {
  const detailed = await materialRequestRepository.findByIdWithDetails(id);
  if (!detailed) {
    throw materialRequestNotFoundError();
  }
  const result = toPublicWithDetails(detailed);
  // CR-BE-MAT-01 PART 02 — derived fulfilment quantities (no separate
  // remaining-quantity table): allowed = approvedQuantity ?? quantity.
  const received = await materialRequestRepository.sumReceivedQuantity(id);
  const allowed = result.approvedQuantity ?? result.quantity;
  result.receivedQuantity = received;
  result.remainingQuantity = allowed - received;
  return result;
}

export function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicMaterialRequest {
  const base = toPublicMaterialRequest(detailed as unknown as MaterialRequestRecord);
  // `findByIdWithDetails` returns the raw NUMERIC column as a string; normalize
  // it back to a number for a consistent API contract.
  if (detailed.quantity !== undefined) {
    base.quantity = Number(detailed.quantity);
  }
  if (detailed.approvedQuantity !== undefined && detailed.approvedQuantity !== null) {
    base.approvedQuantity = Number(detailed.approvedQuantity);
  }

  if (detailed.purchaseRequestNumber) {
    base.purchaseRequest = {
      id: detailed.purchaseRequestId as string,
      requestNumber: detailed.purchaseRequestNumber as string,
      title: detailed.purchaseRequestTitle as string,
      status: detailed.purchaseRequestStatus as string,
    };
  }
  if (detailed.itemCode) {
    base.item = {
      id: detailed.itemId as string,
      code: detailed.itemCode as string,
      name: detailed.itemName as string,
      itemType: detailed.itemType as string,
      uomId: (detailed.uomId as string | null) ?? null,
    };
  }
  if (detailed.warehouseCode) {
    base.warehouse = {
      id: detailed.warehouseId as string,
      code: detailed.warehouseCode as string,
      name: detailed.warehouseName as string,
      buildingId: detailed.buildingId as string,
    };
  }
  return base;
}

/**
 * Lists Material Requests for one Building, optionally filtered by status,
 * purchase request, and item. The Building is validated first (unknown
 * Building → 404 rather than an empty list). Queries stay scoped to
 * `building_id`, so the list can never leak another Building's or Client's
 * requests.
 */
export async function listMaterialRequestsByBuilding(
  buildingId: string,
  filters: MaterialRequestFilters,
): Promise<PublicMaterialRequest[]> {
  const records = await materialRequestRepository.listByBuilding(
    buildingId,
    filters,
  );
  return records.map(toPublicMaterialRequest);
}

/**
 * Lists Material Requests of one Purchase Request, optionally filtered by
 * status and item. The Purchase Request is validated first (unknown PR → 404).
 * Queries stay scoped to the Purchase Request's Building.
 */
export async function listMaterialRequestsByPurchaseRequest(
  purchaseRequestId: string,
  filters: MaterialRequestFilters,
): Promise<PublicMaterialRequest[]> {
  const purchaseRequest = await purchaseRequestRepository.findById(
    purchaseRequestId,
  );
  if (!purchaseRequest) {
    throw purchaseRequestNotFoundError();
  }

  const records = await materialRequestRepository.listByPurchaseRequest(
    purchaseRequestId,
    filters,
  );
  return records.map(toPublicMaterialRequest);
}

/**
 * Lists Material Requests that reference one Item. An Item is Client-scoped,
 * not Building-scoped, so the caller (controller) is responsible for enforcing
 * a Building context on this route. The Item is validated first (unknown Item
 * → 404).
 */
export async function listMaterialRequestsByItem(
  itemId: string,
  filters: MaterialRequestFilters,
): Promise<PublicMaterialRequest[]> {
  const item = await inventoryItemRepository.findById(itemId);
  if (!item) {
    throw inventoryItemNotFoundError();
  }

  const records = await materialRequestRepository.listByItem(itemId, filters);
  return records.map(toPublicMaterialRequest);
}

/**
 * Partially updates an OPEN Material Request (quantity, uomId, warehouseId,
 * requiredDate, notes). `client_id`, `building_id`, `purchase_request_id`, and
 * `item_id` are immutable.
 *
 * CR-BE-MAT-01 PART 02 — Material Request freeze: a request that is no longer
 * OPEN cannot be edited. APPROVED freezes all fulfilment-critical fields
 * (item identity, requested quantity, approved quantity, warehouse/scope) —
 * correction after approval goes through the existing cancellation path.
 * CANCELLED remains terminal.
 */
export async function updateMaterialRequest(
  id: string,
  input: UpdateMaterialRequestInput,
): Promise<PublicMaterialRequest> {
  const existing = await materialRequestRepository.findById(id);
  if (!existing) {
    throw materialRequestNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw materialRequestNotOpenError();
  }

  const item = await inventoryItemRepository.findById(existing.itemId);
  if (!item) {
    throw inventoryItemNotFoundError();
  }

  // quantity must remain positive
  if (input.quantity !== undefined && input.quantity <= 0) {
    throw materialRequestInvalidQuantityError();
  }

  // If updating UOM, it must match the item's UOM.
  const targetUomId =
    input.uomId === undefined ? existing.uomId : resolveUomId(item.uomId, input.uomId);

  // If updating warehouse, it must stay within the same Client/Building.
  let warehouseId = existing.warehouseId;
  if (input.warehouseId !== undefined) {
    if (input.warehouseId === null) {
      warehouseId = null;
    } else {
      const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
      if (!warehouse) {
        throw inventoryWarehouseNotFoundError();
      }
      if (warehouse.clientId !== existing.clientId) {
        throw materialRequestWarehouseClientMismatchError();
      }
      if (warehouse.buildingId !== existing.buildingId) {
        throw materialRequestWarehouseBuildingMismatchError();
      }
      warehouseId = warehouse.id;
    }
  }

  const record = await materialRequestRepository.update(id, {
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
    ...(input.uomId === undefined ? {} : { uomId: targetUomId }),
    ...(input.warehouseId === undefined ? {} : { warehouseId }),
    ...(input.requiredDate === undefined ? {} : { requiredDate: input.requiredDate }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });

  return toPublicMaterialRequest(record as MaterialRequestRecord);
}

/**
 * Cancels a Material Request (OPEN | APPROVED → CANCELLED). Cancellation is
 * the existing correction path after approval (CR-BE-MAT-01 PART 02): an
 * APPROVED line cannot be edited, only cancelled and re-raised. An
 * already-cancelled request cannot be cancelled again. Cancel is not a
 * delete — the request remains persisted for history.
 */
export async function cancelMaterialRequest(
  id: string,
): Promise<PublicMaterialRequest> {
  const record = await withTransaction(async (client) => {
    // Reservation creation, issue, release, and cancellation all lock this
    // source row first. The lock makes the active-allocation check and the
    // terminal state transition one serialized decision.
    const existing = await materialRequestRepository.findByIdForUpdate(
      client,
      id,
    );
    if (!existing) {
      throw materialRequestNotFoundError();
    }
    if (existing.status !== 'OPEN' && existing.status !== 'APPROVED') {
      throw materialRequestNotOpenError();
    }

    const activeReservations =
      await inventoryMaterialReservationRepository.countActiveByMaterialRequest(
        client,
        existing.id,
      );
    if (activeReservations > 0) {
      throw materialRequestActiveReservationError();
    }

    const updated = await materialRequestRepository.updateStatusWithClient(
      client,
      existing.id,
      'CANCELLED',
    );
    if (!updated) {
      throw materialRequestNotFoundError();
    }
    return updated;
  });

  return toPublicMaterialRequest(record);
}

export const materialRequestService = {
  cancelMaterialRequest,
  createMaterialRequest,
  getMaterialRequestById,
  listMaterialRequestsByBuilding,
  listMaterialRequestsByItem,
  listMaterialRequestsByPurchaseRequest,
  toPublicMaterialRequest,
  toPublicWithDetails,
  updateMaterialRequest,
};

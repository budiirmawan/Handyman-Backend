import { withTransaction } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { contextAccessService } from '../context-access';
import { materialRequestRepository } from '../material-requests';
import { materialRequestNotFoundError } from '../material-requests/material-request.errors';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import {
  materialReservationBuildingMismatchError,
  materialReservationClientMismatchError,
  materialReservationDemandExceededError,
  materialReservationDemandNotApprovedError,
  materialReservationInsufficientStockError,
  materialReservationItemMismatchError,
  materialReservationNotActiveError,
  materialReservationNotFoundError,
  materialReservationUomIncompatibleError,
  materialReservationWarehouseMismatchError,
} from './inventory-material-reservation.errors';
import { inventoryMaterialReservationRepository } from './inventory-material-reservation.repository';
import type {
  CreateMaterialReservationInput,
  MaterialReservationFilters,
  MaterialReservationRecord,
  PublicMaterialReservation,
  NewMaterialReservation,
} from './inventory-material-reservation.types';

function toPublic(
  record: MaterialReservationRecord,
): PublicMaterialReservation {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    materialRequestId: record.materialRequestId,
    warehouseId: record.warehouseId,
    itemId: record.itemId,
    uomId: record.uomId,
    reservedQuantity:
      typeof record.reservedQuantity === 'number'
        ? record.reservedQuantity
        : Number(record.reservedQuantity),
    consumedQuantity:
      typeof record.consumedQuantity === 'number'
        ? record.consumedQuantity
        : Number(record.consumedQuantity),
    remainingQuantity:
      typeof record.remainingQuantity === 'number'
        ? record.remainingQuantity
        : Number(record.remainingQuantity),
    status: record.status,
    createdByUserId: record.createdByUserId,
    releasedByUserId: record.releasedByUserId,
    cancelledByUserId: record.cancelledByUserId,
    consumedByUserId: record.consumedByUserId,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    releasedAt: record.releasedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    consumedAt: record.consumedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
    materialRequest: null,
    warehouse: null,
    item: null,
  };
}

function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicMaterialReservation {
  const result = toPublic(detailed as unknown as MaterialReservationRecord);

  if (detailed.materialRequestItemId) {
    result.materialRequest = {
      id: detailed.materialRequestId as string,
      itemId: detailed.materialRequestItemId as string,
      warehouseId: (detailed.materialRequestWarehouseId as string | null) ?? null,
      quantity: Number(detailed.materialRequestQuantity),
      approvedQuantity:
        detailed.materialRequestApprovedQuantity === null ||
        detailed.materialRequestApprovedQuantity === undefined
          ? null
          : Number(detailed.materialRequestApprovedQuantity),
      status: detailed.materialRequestStatus as string,
    };
  }

  if (detailed.warehouseCode) {
    result.warehouse = {
      id: detailed.warehouseId as string,
      code: detailed.warehouseCode as string,
      name: detailed.warehouseName as string,
      buildingId:
        (detailed.warehouseBuildingId as string | null) ??
        (detailed.buildingId as string),
    };
  }

  if (detailed.itemCode) {
    result.item = {
      id: detailed.itemId as string,
      code: detailed.itemCode as string,
      name: detailed.itemName as string,
      itemType: detailed.itemType as string,
      uomId: (detailed.itemUomId as string | null) ?? null,
    };
  }

  return result;
}

async function assertBuildingAccess(
  actorUserId: string,
  buildingId: string,
): Promise<void> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
}

function assertSourceScope(
  reservation: MaterialReservationRecord,
  materialRequest: {
    clientId: string;
    buildingId: string;
    itemId: string;
  },
): void {
  if (reservation.clientId !== materialRequest.clientId) {
    throw materialReservationClientMismatchError();
  }
  if (reservation.buildingId !== materialRequest.buildingId) {
    throw materialReservationBuildingMismatchError();
  }
  if (reservation.itemId !== materialRequest.itemId) {
    throw materialReservationItemMismatchError();
  }
}

function requireActiveDemand(status: string): void {
  if (status !== 'APPROVED') {
    throw materialReservationDemandNotApprovedError();
  }
}

/**
 * Creates an allocation against an existing approved Material Request.
 *
 * Lock order is deliberately:
 *   Material Request → Stock Balance
 *
 * There is no reservation row to lock during creation. Release/cancel uses
 * Material Request → Reservation → Stock Balance. Demand and stock checks are
 * made while the source and balance are locked, and the reservation, balance
 * update, and operational event commit together.
 */
export async function createMaterialReservation(
  input: CreateMaterialReservationInput,
): Promise<PublicMaterialReservation> {
  const result = await withTransaction(async (client) => {
    const materialRequest = await materialRequestRepository.findByIdForUpdate(
      client,
      input.materialRequestId,
    );
    if (!materialRequest) {
      throw materialRequestNotFoundError();
    }

    await assertBuildingAccess(
      input.createdByUserId,
      materialRequest.buildingId,
    );
    requireActiveDemand(materialRequest.status);

    const item = await inventoryItemRepository.findById(materialRequest.itemId);
    if (!item) {
      throw inventoryItemNotFoundError();
    }
    if (item.clientId !== materialRequest.clientId) {
      throw materialReservationClientMismatchError();
    }
    if (
      item.uomId &&
      materialRequest.uomId &&
      item.uomId !== materialRequest.uomId
    ) {
      throw materialReservationUomIncompatibleError();
    }
    if (
      input.itemId !== undefined &&
      input.itemId !== materialRequest.itemId
    ) {
      throw materialReservationItemMismatchError();
    }

    const resolvedUomId = materialRequest.uomId ?? item.uomId ?? null;
    if (input.uomId !== undefined && input.uomId !== resolvedUomId) {
      throw materialReservationUomIncompatibleError();
    }

    const warehouse = await inventoryWarehouseRepository.findById(
      input.warehouseId,
    );
    if (!warehouse) {
      throw inventoryWarehouseNotFoundError();
    }
    if (warehouse.clientId !== materialRequest.clientId) {
      throw materialReservationClientMismatchError();
    }
    if (warehouse.buildingId !== materialRequest.buildingId) {
      throw materialReservationBuildingMismatchError();
    }
    if (
      materialRequest.warehouseId &&
      materialRequest.warehouseId !== warehouse.id
    ) {
      throw materialReservationWarehouseMismatchError();
    }

    const demand = await inventoryMaterialReservationRepository.getDemandSnapshot(
      client,
      materialRequest.id,
      input.quantity,
    );
    if (!demand.reservationAllowed) {
      throw materialReservationDemandExceededError();
    }

    const balance = await inventoryMaterialReservationRepository.findBalanceForUpdate(
      client,
      warehouse.id,
      materialRequest.itemId,
    );
    if (!balance) {
      throw materialReservationInsufficientStockError();
    }

    const updatedBalance =
      await inventoryMaterialReservationRepository.increaseReservedQuantity(
        client,
        balance.id,
        input.quantity,
      );
    if (!updatedBalance) {
      throw materialReservationInsufficientStockError();
    }

    const newReservation: NewMaterialReservation = {
      clientId: materialRequest.clientId,
      buildingId: materialRequest.buildingId,
      materialRequestId: materialRequest.id,
      warehouseId: warehouse.id,
      itemId: materialRequest.itemId,
      uomId: resolvedUomId,
      reservedQuantity: input.quantity,
      status: 'ACTIVE',
      createdByUserId: input.createdByUserId,
      notes: input.notes?.trim() || null,
    };
    const reservation =
      await inventoryMaterialReservationRepository.createWithClient(
        client,
        newReservation,
      );

    await recordOperationalEvent(
      {
        clientId: reservation.clientId,
        buildingId: reservation.buildingId,
        entityType: 'MATERIAL_RESERVATION',
        entityId: reservation.id,
        eventType: 'MATERIAL_RESERVATION_CREATED',
        actorUserId: input.createdByUserId,
        summary: `Material reservation ${reservation.id} created`,
        metadata: {
          materialRequestId: reservation.materialRequestId,
          warehouseId: reservation.warehouseId,
          itemId: reservation.itemId,
          reservedQuantity: input.quantity,
          authorizedDemand: demand.authorizedDemand,
          cumulativeIssued: demand.cumulativeIssued,
          activeReservedBefore: demand.activeReserved,
          remainingDemand: demand.remainingDemand,
          reservableDemandBefore: demand.reservableDemand,
          resultingReservedQuantity: Number(updatedBalance.reservedQuantity),
          resultingAvailableQuantity: Number(updatedBalance.availableQuantity),
        },
      },
      client,
    );

    return reservation;
  });

  const detailed =
    await inventoryMaterialReservationRepository.findByIdWithDetails(result.id);
  return detailed ? toPublicWithDetails(detailed) : toPublic(result);
}

export async function getMaterialReservationById(
  id: string,
  actorUserId: string,
): Promise<PublicMaterialReservation> {
  const detailed =
    await inventoryMaterialReservationRepository.findByIdWithDetails(id);
  if (!detailed) {
    throw materialReservationNotFoundError();
  }
  await assertBuildingAccess(actorUserId, detailed.buildingId as string);
  return toPublicWithDetails(detailed);
}

export async function listMaterialReservationsByMaterialRequest(
  materialRequestId: string,
  filters: Omit<MaterialReservationFilters, 'materialRequestId'>,
  actorUserId: string,
): Promise<PublicMaterialReservation[]> {
  const materialRequest = await materialRequestRepository.findById(
    materialRequestId,
  );
  if (!materialRequest) {
    throw materialRequestNotFoundError();
  }
  await assertBuildingAccess(actorUserId, materialRequest.buildingId);

  const records =
    await inventoryMaterialReservationRepository.listByMaterialRequest({
      materialRequestId,
      status: filters.status,
    });
  return records.map(toPublic);
}

async function transitionMaterialReservation(
  id: string,
  status: 'RELEASED' | 'CANCELLED',
  actorUserId: string,
): Promise<PublicMaterialReservation> {
  const existing = await inventoryMaterialReservationRepository.findById(id);
  if (!existing) {
    throw materialReservationNotFoundError();
  }

  const result = await withTransaction(async (client) => {
    // The source id is immutable, so this read establishes which source row to
    // lock before locking the reservation itself.
    const materialRequest = await materialRequestRepository.findByIdForUpdate(
      client,
      existing.materialRequestId,
    );
    if (!materialRequest) {
      throw materialRequestNotFoundError();
    }
    await assertBuildingAccess(actorUserId, materialRequest.buildingId);

    const reservation =
      await inventoryMaterialReservationRepository.findByIdForUpdate(
        client,
        id,
      );
    if (!reservation) {
      throw materialReservationNotFoundError();
    }
    if (reservation.status !== 'ACTIVE') {
      throw materialReservationNotActiveError();
    }
    assertSourceScope(reservation, materialRequest);

    const balance =
      await inventoryMaterialReservationRepository.findBalanceForUpdate(
        client,
        reservation.warehouseId,
        reservation.itemId,
      );
    if (!balance) {
      throw materialReservationInsufficientStockError();
    }

    const updatedBalance =
      await inventoryMaterialReservationRepository.decreaseReservedQuantity(
        client,
        balance.id,
        reservation.remainingQuantity,
      );
    if (!updatedBalance) {
      throw materialReservationInsufficientStockError();
    }

    const transitioned =
      await inventoryMaterialReservationRepository.transitionWithClient(
        client,
        reservation.id,
        status,
        actorUserId,
      );
    if (!transitioned) {
      throw materialReservationNotActiveError();
    }

    const eventType =
      status === 'RELEASED'
        ? 'MATERIAL_RESERVATION_RELEASED'
        : 'MATERIAL_RESERVATION_CANCELLED';
    const action = status === 'RELEASED' ? 'released' : 'cancelled';
    await recordOperationalEvent(
      {
        clientId: transitioned.clientId,
        buildingId: transitioned.buildingId,
        entityType: 'MATERIAL_RESERVATION',
        entityId: transitioned.id,
        eventType,
        actorUserId,
        summary: `Material reservation ${transitioned.id} ${action}`,
        metadata: {
          materialRequestId: transitioned.materialRequestId,
          warehouseId: transitioned.warehouseId,
          itemId: transitioned.itemId,
          reservedQuantity: transitioned.reservedQuantity,
          resultingReservedQuantity: Number(updatedBalance.reservedQuantity),
          resultingAvailableQuantity: Number(updatedBalance.availableQuantity),
        },
      },
      client,
    );

    return transitioned;
  });

  const detailed =
    await inventoryMaterialReservationRepository.findByIdWithDetails(result.id);
  return detailed ? toPublicWithDetails(detailed) : toPublic(result);
}

export async function releaseMaterialReservation(
  id: string,
  actorUserId: string,
): Promise<PublicMaterialReservation> {
  return transitionMaterialReservation(id, 'RELEASED', actorUserId);
}

export async function cancelMaterialReservation(
  id: string,
  actorUserId: string,
): Promise<PublicMaterialReservation> {
  return transitionMaterialReservation(id, 'CANCELLED', actorUserId);
}

export const inventoryMaterialReservationService = {
  cancelMaterialReservation,
  createMaterialReservation,
  getMaterialReservationById,
  listMaterialReservationsByMaterialRequest,
  releaseMaterialReservation,
  toPublic,
  toPublicWithDetails,
};

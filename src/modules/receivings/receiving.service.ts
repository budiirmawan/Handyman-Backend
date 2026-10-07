import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { getPool } from '../../database';
import { purchaseRequestRepository } from '../purchase-requests';
import { serviceRequestRepository } from '../service-requests';
import { materialRequestRepository } from '../material-requests';
import { vendorRepository } from '../vendors';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { poReadinessRepository } from '../purchase-order-readiness';
import { inventoryStockMovementService } from '../inventory-stock-movements';
import {
  receivingAlreadyFinalizedError,
  receivingInvalidQuantityError,
  receivingItemClientMismatchError,
  receivingMaterialRequestInvalidError,
  receivingMaterialRequestItemMismatchError,
  receivingMaterialRequestScopeMismatchError,
  receivingNotFoundError,
  receivingOverReceiptError,
  receivingReadinessInvalidError,
  receivingRequestInvalidError,
  receivingUomIncompatibleError,
  receivingVendorInvalidError,
  receivingWarehouseBuildingMismatchError,
  receivingWarehouseClientMismatchError,
} from './receiving.errors';
import { receivingRepository } from './receiving.repository';
import type {
  CreateReceivingInput,
  NewReceiving,
  PublicReceiving,
  ReceivingFilters,
  ReceivingRecord,
  ReceivingRequestType,
  UpdateReceivingInput,
} from './receiving.types';

type RequestContext = {
  clientId: string;
  buildingId: string;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
};

function requestId(record: ReceivingRecord): string {
  return (record.purchaseRequestId ?? record.serviceRequestId)!;
}

export function toPublicReceiving(record: ReceivingRecord): PublicReceiving {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestType: record.requestType,
    purchaseRequestId: record.purchaseRequestId,
    serviceRequestId: record.serviceRequestId,
    materialRequestId: record.materialRequestId,
    requestId: requestId(record),
    vendorId: record.vendorId,
    receivingType: record.receivingType,
    itemId: record.itemId,
    warehouseId: record.warehouseId,
    quantity: record.quantity,
    uomId: record.uomId,
    stockMovementId: record.stockMovementId,
    receivedByUserId: record.receivedByUserId,
    receivedAt: record.receivedAt.toISOString(),
    status: record.status,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    vendor: null,
    item: null,
    warehouse: null,
  };
}

export function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicReceiving {
  const base = toPublicReceiving(detailed as unknown as ReceivingRecord);
  // `findByIdWithDetails` returns raw NUMERIC quantity as a string; normalize.
  if (detailed.quantity !== undefined && detailed.quantity !== null) {
    base.quantity = Number(detailed.quantity);
  }
  if (detailed.vendorCode) {
    base.vendor = {
      id: detailed.vendorId as string,
      vendorCode: detailed.vendorCode as string,
      vendorName: detailed.vendorName as string,
      status: detailed.vendorStatus as string,
    };
  }
  if (detailed.itemCode) {
    base.item = {
      id: detailed.itemId as string,
      code: detailed.itemCode as string,
      name: detailed.itemName as string,
      itemType: detailed.itemType as string,
    };
  }
  if (detailed.warehouseCode) {
    base.warehouse = {
      id: detailed.warehouseId as string,
      code: detailed.warehouseCode as string,
      name: detailed.warehouseName as string,
      buildingId:
        (detailed.warehouseBuildingId as string) ?? (detailed.buildingId as string),
    };
  }
  return base;
}

async function resolveRequest(
  type: ReceivingRequestType,
  id: string,
): Promise<RequestContext> {
  if (type === 'PURCHASE_REQUEST') {
    const pr = await purchaseRequestRepository.findById(id);
    if (!pr) throw receivingRequestInvalidError();
    return {
      clientId: pr.clientId,
      buildingId: pr.buildingId,
      purchaseRequestId: pr.id,
      serviceRequestId: null,
    };
  }
  const sr = await serviceRequestRepository.findById(id);
  if (!sr) throw receivingRequestInvalidError();
  return {
    clientId: sr.clientId,
    buildingId: sr.buildingId,
    purchaseRequestId: null,
    serviceRequestId: sr.id,
  };
}

/**
 * Records a receiving (material or service) for an approved request + Vendor.
 *
 * 1. Resolve + isolate the request; validate the Vendor (same Client).
 * 2. Require a READY `purchase_order_readiness` (BE-17F) for request + vendor.
 * 3. For MATERIAL receiving: validate item + warehouse context and positive
 *    quantity. When a Material Request line is referenced
 *    (CR-BE-MAT-01 PART 01), lock the line, enforce line identity (same
 *    Purchase Request / Client / Building / item / target warehouse) and the
 *    cumulative over-receipt guard, then reuse the BE-16 stock-in logic
 *    (`postStockMovementWithClient` with STOCK_IN) and insert the receiving in
 *    the SAME transaction — a failed guard mutates nothing, and a committed
 *    receiving always has its STOCK_IN.
 * 4. For SERVICE receiving: record acceptance without any stock movement.
 */
export async function createReceiving(
  input: CreateReceivingInput,
  actorUserId: string,
): Promise<PublicReceiving> {
  const target = await resolveRequest(input.requestType, input.requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);

  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) throw receivingVendorInvalidError();
  if (vendor.clientId !== target.clientId) throw receivingVendorInvalidError();

  await assertReadyReadiness(input.vendorId, target);

  // A Material Request line reference is only meaningful for MATERIAL
  // receiving against a Purchase Request.
  if (
    input.materialRequestId &&
    (input.receivingType !== 'MATERIAL' || input.requestType !== 'PURCHASE_REQUEST')
  ) {
    throw receivingMaterialRequestInvalidError();
  }

  let itemId: string | null = null;
  let warehouseId: string | null = null;
  let quantity: number | null = null;
  let itemUomId: string | null = null;

  if (input.receivingType === 'MATERIAL') {
    if (!input.itemId) throw receivingInvalidQuantityError();
    const item = await inventoryItemRepository.findById(input.itemId);
    if (!item) throw receivingRequestInvalidError();
    if (item.clientId !== target.clientId) throw receivingItemClientMismatchError();
    if (!input.quantity || input.quantity <= 0) throw receivingInvalidQuantityError();

    if (!input.warehouseId) throw receivingInvalidQuantityError();
    const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
    if (!warehouse) throw receivingRequestInvalidError();
    if (warehouse.clientId !== target.clientId) throw receivingWarehouseClientMismatchError();
    if (warehouse.buildingId !== target.buildingId) throw receivingWarehouseBuildingMismatchError();

    itemId = item.id;
    warehouseId = warehouse.id;
    quantity = input.quantity;
    itemUomId = item.uomId ?? null;
  } else if (input.uomId) {
    // PART 04 — a UOM only applies to material quantities.
    throw receivingUomIncompatibleError();
  }

  const receivedAt = new Date();
  const baseRecord: Omit<
    NewReceiving,
    'materialRequestId' | 'stockMovementId' | 'uomId'
  > = {
    clientId: target.clientId,
    buildingId: target.buildingId,
    requestType: input.requestType,
    purchaseRequestId: target.purchaseRequestId,
    serviceRequestId: target.serviceRequestId,
    vendorId: vendor.id,
    receivingType: input.receivingType,
    itemId,
    warehouseId,
    quantity,
    receivedByUserId: actorUserId,
    receivedAt,
    status: 'RECEIVED',
    notes: input.notes?.trim() || null,
  };

  let record: ReceivingRecord;

  if (input.receivingType === 'MATERIAL') {
    // MATERIAL: line guard + STOCK_IN + receiving insert in ONE transaction so
    // no partial state (movement without receiving, or vice versa) can remain.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let materialRequestId: string | null = null;
      // PART 04 — UOM snapshot at receipt time; the MR-line UOM is
      // authoritative when the receiving is bound to a line.
      let receivingUomId: string | null = itemUomId;
      if (input.materialRequestId) {
        // Lock the authoritative Material Request line so concurrent
        // receivings serialize on the over-receipt guard.
        const line = await materialRequestRepository.findByIdForUpdate(
          client,
          input.materialRequestId,
        );
        // PART 02: an APPROVED line is the normal fulfilment state (approved
        // quantity is the cap); historical OPEN lines without an approved
        // quantity stay receivable against the requested quantity. Cancelled
        // lines are never receivable.
        if (!line || (line.status !== 'OPEN' && line.status !== 'APPROVED')) {
          throw receivingMaterialRequestInvalidError();
        }
        if (
          line.clientId !== target.clientId ||
          line.buildingId !== target.buildingId
        ) {
          throw receivingMaterialRequestScopeMismatchError();
        }
        if (line.purchaseRequestId !== target.purchaseRequestId) {
          throw receivingMaterialRequestInvalidError();
        }
        if (line.itemId !== itemId) {
          throw receivingMaterialRequestItemMismatchError();
        }
        if (line.warehouseId && line.warehouseId !== warehouseId) {
          throw receivingMaterialRequestScopeMismatchError();
        }

        // PART 04 — no UOM conversion exists: when the line and the item both
        // carry a UOM they must agree, otherwise the receipt is rejected. A
        // legacy line without a UOM falls back to the item's UOM.
        if (line.uomId && itemUomId && line.uomId !== itemUomId) {
          throw receivingUomIncompatibleError();
        }
        receivingUomId = line.uomId ?? itemUomId;

        const guard = await receivingRepository.checkOverReceipt(
          client,
          line.id,
          quantity!,
        );
        if (guard.over) {
          throw receivingOverReceiptError();
        }
        materialRequestId = line.id;
      }

      // PART 04 — an explicitly supplied UOM must match the resolved snapshot
      // exactly; incompatible quantity units are never silently accepted.
      if (
        input.uomId !== undefined &&
        input.uomId !== null &&
        input.uomId !== receivingUomId
      ) {
        throw receivingUomIncompatibleError();
      }

      const movement = await inventoryStockMovementService.postStockMovementWithClient(
        client,
        {
          warehouseId: warehouseId!,
          itemId: itemId!,
          movementType: 'STOCK_IN',
          quantity: quantity!,
          reference: `RECEIVING:${target.purchaseRequestId ?? target.serviceRequestId}`,
          source: 'PROCUREMENT_RECEIVING',
          notes: input.notes?.trim() || `Procurement receiving`,
          performedByUserId: actorUserId,
        },
      );

      record = await receivingRepository.createWithClient(client, {
        ...baseRecord,
        materialRequestId,
        stockMovementId: movement.record.id,
        uomId: receivingUomId,
      });

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  } else {
    record = await receivingRepository.create({
      ...baseRecord,
      materialRequestId: null,
      stockMovementId: null,
      uomId: null,
    });
  }

  const detailed = await receivingRepository.findByIdWithDetails(record.id);
  return detailed ? toPublicWithDetails(detailed) : toPublicReceiving(record);
}

async function assertReadyReadiness(
  vendorId: string,
  target: RequestContext,
): Promise<void> {
  const readiness = await poReadinessRepository.findExisting(
    vendorId,
    target.purchaseRequestId,
    target.serviceRequestId,
  );
  if (!readiness || readiness.readiness !== 'READY') {
    throw receivingReadinessInvalidError();
  }
}

export async function getReceiving(
  id: string,
  actorUserId: string,
): Promise<PublicReceiving> {
  const detailed = await receivingRepository.findByIdWithDetails(id);
  if (!detailed) throw receivingNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    (detailed as unknown as ReceivingRecord).buildingId,
  );
  return toPublicWithDetails(detailed);
}

export async function listReceivingsByRequest(
  requestType: ReceivingRequestType,
  requestId: string,
  filters: ReceivingFilters,
  actorUserId: string,
): Promise<PublicReceiving[]> {
  const target = await resolveRequest(requestType, requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);
  const records = await receivingRepository.listByRequest(
    target.purchaseRequestId,
    target.serviceRequestId,
    target.buildingId,
    filters,
  );
  return records.map(toPublicReceiving);
}

export async function listReceivingsByVendor(
  vendorId: string,
  filters: ReceivingFilters,
  actorUserId: string,
): Promise<PublicReceiving[]> {
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await receivingRepository.listByVendor(
    vendorId,
    buildingIds,
    filters,
  );
  return records.map(toPublicReceiving);
}

export async function listReceivingsByBuilding(
  buildingId: string,
  filters: ReceivingFilters,
  actorUserId: string,
): Promise<PublicReceiving[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  const records = await receivingRepository.listByBuilding(buildingId, filters);
  return records.map(toPublicReceiving);
}

/**
 * Updates notes on a RECEIVED record. A FINALIZED record is immutable.
 */
export async function updateReceiving(
  id: string,
  input: UpdateReceivingInput,
  actorUserId: string,
): Promise<PublicReceiving> {
  const existing = await receivingRepository.findById(id);
  if (!existing) throw receivingNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  if (existing.status !== 'RECEIVED') throw receivingAlreadyFinalizedError();

  const updated = await receivingRepository.update(id, {
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });
  return toPublicReceiving(updated as ReceivingRecord);
}

/**
 * Finalizes a RECEIVED record (RECEIVED → FINALIZED). Idempotent guard: an
 * already-FINALIZED record cannot be finalized again (duplicate/final
 * receiving protected).
 */
export async function finalizeReceiving(
  id: string,
  actorUserId: string,
): Promise<PublicReceiving> {
  const existing = await receivingRepository.findById(id);
  if (!existing) throw receivingNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  if (existing.status !== 'RECEIVED') throw receivingAlreadyFinalizedError();

  const finalized = await receivingRepository.finalize(id);
  return toPublicReceiving(finalized as ReceivingRecord);
}

export const receivingService = {
  createReceiving,
  finalizeReceiving,
  getReceiving,
  listReceivingsByBuilding,
  listReceivingsByRequest,
  listReceivingsByVendor,
  toPublicReceiving,
  toPublicWithDetails,
  updateReceiving,
};

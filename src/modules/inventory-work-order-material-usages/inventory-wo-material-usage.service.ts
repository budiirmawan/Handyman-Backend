import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { assertActiveAllowedCurrencyCommand } from '../client-monetary-contexts';
import { recordOperationalEvent } from '../operational-events';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { workOrderRepository } from '../work-orders';
import { materialRequestRepository } from '../material-requests';
import { purchaseRequestRepository } from '../purchase-requests/purchase-request.repository';
import { materialRequestNotFoundError } from '../material-requests/material-request.errors';
import { workOrderProcurementBindingRepository } from '../work-order-procurement-bindings/work-order-procurement-binding.repository';
import { inventoryStockMovementService } from '../inventory-stock-movements';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import { workOrderNotFoundError } from '../work-orders/work-order.errors';
import { inventoryMaterialReservationRepository } from '../inventory-material-reservations/inventory-material-reservation.repository';
// CR-BE-COMM-VAR-01 PART 03 — direct module path keeps this import free of the
// operational-finance barrel and its route/controller graph.
import { operationalCommitmentMaterialService } from '../operational-finance/operational-commitment-material.service';
import {
  materialReservationAllocationExceededError,
  materialReservationNotActiveError,
  materialReservationNotFoundError,
} from '../inventory-material-reservations/inventory-material-reservation.errors';
import {
  woMaterialUsageBuildingMismatchError,
  woMaterialUsageClientMismatchError,
  woMaterialUsageCurrencyRequiredError,
  woMaterialUsageDemandExceededError,
  woMaterialUsageDuplicateReferenceError,
  woMaterialUsageInsufficientStockError,
  woMaterialUsageInvalidQuantityError,
  woMaterialUsageInvalidUnitCostError,
  woMaterialUsageMaterialRequestInvalidError,
  woMaterialUsageMaterialRequestNotApprovedError,
  woMaterialUsageMaterialRequestRequiredError,
  woMaterialUsageReservationMismatchError,
  woMaterialUsageUomIncompatibleError,
  woMaterialUsageWorkOrderStateInvalidError,
  woMaterialUsageNotFoundError,
} from './inventory-wo-material-usage.errors';
import { inventoryWorkOrderMaterialUsageRepository } from './inventory-wo-material-usage.repository';
import type {
  CreateWorkOrderMaterialUsageInput,
  PublicWorkOrderMaterialUsage,
  WorkOrderMaterialCostSummary,
  WorkOrderMaterialUsageFilters,
  NewWorkOrderMaterialUsage,
} from './inventory-wo-material-usage.types';

function toPublic(row: any): PublicWorkOrderMaterialUsage {
  const base: PublicWorkOrderMaterialUsage = {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    workOrderId: row.workOrderId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    materialRequestId: row.materialRequestId ?? null,
    reservationId: row.reservationId ?? null,
    quantity: typeof row.quantity === 'number' ? row.quantity : Number(row.quantity),
    uomId: row.uomId ?? null,
    unitCost: row.unitCost === null || row.unitCost === undefined ? null : Number(row.unitCost),
    totalCost: row.totalCost === null || row.totalCost === undefined ? null : Number(row.totalCost),
    currency: row.currency ?? null,
    costSource: row.costSource ?? null,
    costReference: row.costReference ?? null,
    stockMovementId: row.stockMovementId ?? null,
    usedByUserId: row.usedByUserId,
    usedAt: row.usedAt instanceof Date ? row.usedAt.toISOString() : String(row.usedAt),
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    resultingQuantityOnHand: typeof row.resultingQuantityOnHand === 'number' ? row.resultingQuantityOnHand : Number(row.resultingQuantityOnHand),
    resultingAvailableQuantity: typeof row.resultingAvailableQuantity === 'number' ? row.resultingAvailableQuantity : Number(row.resultingAvailableQuantity),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    workOrder: null,
    warehouse: null,
    item: null,
    resultingBalance: {
      quantityOnHand: typeof row.resultingQuantityOnHand === 'number' ? row.resultingQuantityOnHand : Number(row.resultingQuantityOnHand),
      reservedQuantity: 0,
      availableQuantity: typeof row.resultingAvailableQuantity === 'number' ? row.resultingAvailableQuantity : Number(row.resultingAvailableQuantity),
    },
  };

  if (row.workOrderNumber) {
    base.workOrder = {
      id: row.workOrderId,
      workOrderNumber: row.workOrderNumber,
      title: row.workOrderTitle,
      status: row.workOrderStatus,
    };
  }
  if (row.warehouseCode) {
    base.warehouse = {
      id: row.warehouseId,
      code: row.warehouseCode,
      name: row.warehouseName,
      buildingId: row.warehouseBuildingId ?? row.buildingId,
    };
  }
  if (row.itemCode) {
    base.item = {
      id: row.itemId,
      code: row.itemCode,
      name: row.itemName,
      itemType: row.itemType,
    };
  }

  if (base.resultingBalance) {
    base.resultingBalance.reservedQuantity =
      base.resultingQuantityOnHand - base.resultingAvailableQuantity;
  }

  return base;
}

async function assertBuildingAccess(actorUserId: string | undefined, buildingId: string): Promise<void> {
  if (!actorUserId) return;
  const ok = await contextAccessService.canAccessBuilding(actorUserId, buildingId);
  if (!ok) throw buildingAccessDeniedError();
}

async function assertClientAccess(actorUserId: string | undefined, clientId: string): Promise<void> {
  if (!actorUserId) return;
  const ok = await contextAccessService.canAccessClient(actorUserId, clientId);
  if (!ok) throw buildingAccessDeniedError();
}

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 03 — Work Order → Material Request
 * ownership resolver for the usage/issue engine.
 *
 * Two canonical relations admit a Material Request to a Work Order:
 *   A. FIELD  — material_requests.purchase_request_id → purchase_requests.id
 *               → purchase_requests.work_order_id == workOrderId (PART 00).
 *   B. LEGACY — work_order_procurement_bindings.material_request_id (one row
 *               per Work Order; management flows).
 *
 * `materialRequestId` supplied  → valid if A or B holds, else
 *   INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID.
 * `materialRequestId` omitted   → LEGACY behaviour preserved verbatim: the
 *   binding's material request is used; without a binding →
 *   INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_REQUIRED. A Work Order with
 *   several field requests is NEVER auto-selected among (callers must name one).
 */
export async function resolveWorkOrderMaterialRequestId(
  workOrderId: string,
  requestedMaterialRequestId: string | undefined,
): Promise<string> {
  const binding = await workOrderProcurementBindingRepository.findByWorkOrderId(workOrderId);
  if (requestedMaterialRequestId === undefined) {
    if (!binding?.materialRequestId) {
      throw woMaterialUsageMaterialRequestRequiredError();
    }
    return binding.materialRequestId;
  }
  if (binding?.materialRequestId === requestedMaterialRequestId) {
    return requestedMaterialRequestId;
  }
  const materialRequest = await materialRequestRepository.findById(requestedMaterialRequestId);
  if (materialRequest) {
    const parent = await purchaseRequestRepository.findById(materialRequest.purchaseRequestId);
    if (parent?.workOrderId === workOrderId) {
      return materialRequest.id;
    }
  }
  throw woMaterialUsageMaterialRequestInvalidError();
}

/**
 * Record a demand-linked Work Order material issue.
 *
 * The existing Work Order usage and stock movement authorities remain in place:
 * the operation resolves its Material Request through
 * `resolveWorkOrderMaterialRequestId` (field parent relation OR legacy
 * binding), locks that approved demand before calculating the cap, and then
 * delegates stock mutation to the transaction-aware stock movement core. Lock
 * order is Material Request → Reservation (when supplied) → Stock Balance →
 * Movement/Usage persistence.
 *
 * `executor` (PART 03): when supplied, the whole issue runs inside the
 * caller's already-open transaction (idempotent field command) instead of
 * opening its own — the lock order and every guard are identical.
 */
export async function recordMaterialUsage(
  input: CreateWorkOrderMaterialUsageInput,
  executor?: PoolClient,
): Promise<PublicWorkOrderMaterialUsage> {
  if (!input.quantity || input.quantity <= 0) {
    throw woMaterialUsageInvalidQuantityError();
  }

  if (
    input.unitCost !== undefined &&
    (typeof input.unitCost !== 'number' ||
      !Number.isFinite(input.unitCost) ||
      input.unitCost < 0)
  ) {
    throw woMaterialUsageInvalidUnitCostError();
  }

  /* CUR-02 PART 03 — a costed usage must carry an explicit governed currency.
     The format gate lives in the validation layer; here we fail closed if a
     cost was supplied without a currency, then validate ACTIVE + Client-allowed
     against the resolved Work Order Client. A non-costed usage (no unitCost)
     is not blocked by currency governance. */
  if (input.unitCost !== undefined && input.currency === undefined) {
    throw woMaterialUsageCurrencyRequiredError();
  }

  const workOrder = await workOrderRepository.findById(input.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }

  if (input.unitCost !== undefined) {
    await assertActiveAllowedCurrencyCommand(workOrder.clientId, input.currency!);
  }

  if (
    workOrder.status === 'COMPLETED' ||
    workOrder.status === 'CANCELLED' ||
    workOrder.status === 'CLOSED'
  ) {
    throw woMaterialUsageWorkOrderStateInvalidError();
  }

  const materialRequestId = await resolveWorkOrderMaterialRequestId(
    workOrder.id,
    input.materialRequestId,
  );

  const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
  if (!warehouse) {
    throw inventoryWarehouseNotFoundError();
  }

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) {
    throw inventoryItemNotFoundError();
  }

  if (
    input.uomId !== undefined &&
    input.uomId !== null &&
    input.uomId !== (item.uomId ?? null)
  ) {
    throw woMaterialUsageUomIncompatibleError();
  }

  if (
    workOrder.clientId !== warehouse.clientId ||
    workOrder.clientId !== item.clientId
  ) {
    throw woMaterialUsageClientMismatchError();
  }

  if (warehouse.buildingId !== workOrder.buildingId) {
    throw woMaterialUsageBuildingMismatchError();
  }

  if (input.usedByUserId) {
    await assertBuildingAccess(input.usedByUserId, workOrder.buildingId);
  }

  const issueWork = async (client: PoolClient) => {
    // Demand is the first row lock. Every new controlled issue for the same
    // Material Request therefore serializes its cumulative issued calculation.
    const materialRequest = await materialRequestRepository.findByIdForUpdate(
      client,
      materialRequestId,
    );
    if (!materialRequest) {
      throw materialRequestNotFoundError();
    }
    if (materialRequest.status !== 'APPROVED') {
      throw woMaterialUsageMaterialRequestNotApprovedError();
    }
    if (
      materialRequest.clientId !== workOrder.clientId ||
      materialRequest.clientId !== item.clientId
    ) {
      throw woMaterialUsageClientMismatchError();
    }
    if (materialRequest.buildingId !== workOrder.buildingId) {
      throw woMaterialUsageBuildingMismatchError();
    }
    if (materialRequest.itemId !== item.id) {
      throw woMaterialUsageMaterialRequestInvalidError();
    }
    if (
      materialRequest.uomId &&
      item.uomId &&
      materialRequest.uomId !== item.uomId
    ) {
      throw woMaterialUsageUomIncompatibleError();
    }
    const resolvedUomId = materialRequest.uomId ?? item.uomId ?? null;
    if (
      input.uomId !== undefined &&
      input.uomId !== null &&
      input.uomId !== resolvedUomId
    ) {
      throw woMaterialUsageUomIncompatibleError();
    }

    let reservation: Awaited<
      ReturnType<typeof inventoryMaterialReservationRepository.findByIdForUpdate>
    > = null;
    if (input.reservationId) {
      reservation =
        await inventoryMaterialReservationRepository.findByIdForUpdate(
          client,
          input.reservationId,
        );
      if (!reservation) {
        throw materialReservationNotFoundError();
      }
      if (reservation.status !== 'ACTIVE') {
        throw materialReservationNotActiveError();
      }
      if (
        reservation.materialRequestId !== materialRequest.id ||
        reservation.clientId !== workOrder.clientId ||
        reservation.buildingId !== workOrder.buildingId ||
        reservation.warehouseId !== warehouse.id ||
        reservation.itemId !== item.id ||
        reservation.uomId !== resolvedUomId
      ) {
        throw woMaterialUsageReservationMismatchError();
      }
    }

    const demand = await inventoryMaterialReservationRepository.getDemandSnapshot(
      client,
      materialRequest.id,
      input.quantity,
    );
    if (!demand.issueAllowed) {
      throw woMaterialUsageDemandExceededError();
    }

    const referenceValue = input.reference?.trim() || null;
    if (referenceValue) {
      const duplicate =
        await inventoryWorkOrderMaterialUsageRepository.existsByWorkOrderAndReference(
          client,
          workOrder.id,
          referenceValue,
        );
      if (duplicate) {
        throw woMaterialUsageDuplicateReferenceError();
      }
    }

    let consumedReservation = null;
    if (reservation) {
      // Consume the locked allocation before asking the stock ledger to post
      // the issue. Both updates are in this transaction; a stock failure rolls
      // the reservation progress back. This gives an allocation-specific
      // conflict instead of allowing the generic stock error to mask it.
      consumedReservation =
        await inventoryMaterialReservationRepository.consumeWithClient(
          client,
          reservation.id,
          input.quantity,
          input.usedByUserId,
        );
      if (!consumedReservation) {
        throw materialReservationAllocationExceededError();
      }
    }

    // The existing stock movement authority locks the balance and writes the
    // STOCK_OUT. Passing the internal allocation option makes a reservation-backed
    // issue reduce on-hand and reserved quantities together, keeping available
    // stock unchanged instead of subtracting the same quantity twice.
    let movement;
    try {
      movement =
        await inventoryStockMovementService.postStockMovementWithClient(client, {
          warehouseId: warehouse.id,
          itemId: item.id,
          movementType: 'STOCK_OUT',
          quantity: input.quantity,
          ...(reservation ? { reservedQuantityToConsume: input.quantity } : {}),
          movementDate: input.usedAt,
          reference: referenceValue ?? undefined,
          source: `WORK_ORDER:${workOrder.id}`,
          performedByUserId: input.usedByUserId,
          notes:
            input.notes?.trim() ||
            `Work order ${workOrder.workOrderNumber} material usage`,
        });
    } catch (error) {
      // Keep the Work Order usage error contract when the shared ledger core
      // rejects the STOCK_OUT for insufficient stock.
      if (
        error instanceof AppError &&
        error.code === ERROR_CODES.INVENTORY_STOCK_MOVEMENT_INSUFFICIENT_STOCK
      ) {
        throw woMaterialUsageInsufficientStockError();
      }
      throw error;
    }

    const usedAt = input.usedAt ? new Date(input.usedAt) : new Date();
    const newUsage: NewWorkOrderMaterialUsage = {
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      workOrderId: workOrder.id,
      warehouseId: warehouse.id,
      itemId: item.id,
      materialRequestId: materialRequest.id,
      reservationId: reservation?.id ?? null,
      quantity: input.quantity,
      uomId: resolvedUomId,
      unitCost: input.unitCost ?? null,
      currency: input.unitCost === undefined ? null : (input.currency ?? null),
      costSource:
        input.unitCost === undefined ? null : (input.costSource?.trim() || 'MANUAL'),
      costReference:
        input.unitCost === undefined ? null : (input.costReference?.trim() || null),
      stockMovementId: movement.record.id,
      usedByUserId: input.usedByUserId,
      usedAt,
      reference: referenceValue,
      notes: input.notes?.trim() || null,
      resultingQuantityOnHand: movement.quantityOnHand,
      resultingAvailableQuantity: movement.availableQuantity,
    };

    const createdUsage =
      await inventoryWorkOrderMaterialUsageRepository.createWithClient(
        client,
        newUsage,
      );

    await recordOperationalEvent(
      {
        clientId: workOrder.clientId,
        buildingId: workOrder.buildingId,
        entityType: 'WORK_ORDER',
        entityId: workOrder.id,
        eventType: 'WORK_ORDER_MATERIAL_ISSUED',
        actorUserId: input.usedByUserId,
        summary: `Material issued to work order ${workOrder.workOrderNumber}`,
        metadata: {
          materialRequestId: materialRequest.id,
          reservationId: reservation?.id ?? null,
          usageId: createdUsage.id,
          stockMovementId: movement.record.id,
          quantity: input.quantity,
          unitCost: createdUsage.unitCost,
          totalCost: createdUsage.unitCost === null ? null : (input.quantity * createdUsage.unitCost),
          currency: createdUsage.currency,
          authorizedDemand: demand.authorizedDemand,
          cumulativeIssuedBefore: demand.cumulativeIssued,
          remainingDemandBefore: demand.remainingDemand,
        },
      },
      client,
    );

    if (consumedReservation) {
      await recordOperationalEvent(
        {
          clientId: consumedReservation.clientId,
          buildingId: consumedReservation.buildingId,
          entityType: 'MATERIAL_RESERVATION',
          entityId: consumedReservation.id,
          eventType: 'MATERIAL_RESERVATION_CONSUMED',
          actorUserId: input.usedByUserId,
          summary: `Material reservation ${consumedReservation.id} consumed`,
          metadata: {
            materialRequestId: consumedReservation.materialRequestId,
            workOrderId: workOrder.id,
            usageId: createdUsage.id,
            stockMovementId: movement.record.id,
            quantity: input.quantity,
            consumedQuantity: consumedReservation.consumedQuantity,
            remainingQuantity: consumedReservation.remainingQuantity,
            status: consumedReservation.status,
          },
        },
        client,
      );
    }

    // CR-BE-COMM-VAR-01 PART 03 — operational cost control seam.
    //
    // Runs inside this transaction so the actualization commits atomically
    // with the issue, but inside its own SAVEPOINT so a finance-side problem
    // can never fail an authorised material issue. Budget availability does
    // NOT gate physical material movement: only commitment creation is gated.
    await operationalCommitmentMaterialService.tryActualizeWorkOrderMaterialUsage(
      client,
      {
        usageId: createdUsage.id,
        usedOn: usedAt.toISOString().slice(0, 10),
        clientId: createdUsage.clientId,
        buildingId: createdUsage.buildingId,
        workOrderId: createdUsage.workOrderId,
        materialRequestId: createdUsage.materialRequestId,
        totalCost:
          createdUsage.unitCost === null || createdUsage.unitCost === undefined
            ? null
            : (createdUsage.quantity * createdUsage.unitCost).toFixed(2),
        currency: createdUsage.currency ?? null,
        actorUserId: input.usedByUserId,
      },
    );

    return { createdUsage, movement };
  };

  const transactionResult = executor
    ? await issueWork(executor)
    : await withTransaction(issueWork);

  const detailed =
    await inventoryWorkOrderMaterialUsageRepository.findByIdWithDetails(
      transactionResult.createdUsage.id,
      executor,
    );
  return toPublic(detailed ?? transactionResult.createdUsage);
}

export async function getUsageById(id: string, actorUserId?: string): Promise<PublicWorkOrderMaterialUsage> {
  const detailed = await inventoryWorkOrderMaterialUsageRepository.findByIdWithDetails(id);
  if (!detailed) throw woMaterialUsageNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId);
  }
  return toPublic(detailed);
}

export async function listUsages(
  filters: WorkOrderMaterialUsageFilters,
  actorUserId?: string,
): Promise<PublicWorkOrderMaterialUsage[]> {
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw woMaterialUsageClientMismatchError();
    if (filters.buildingId && wh.buildingId !== filters.buildingId) throw woMaterialUsageBuildingMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  } else if (filters.buildingId) {
    if (actorUserId) await assertBuildingAccess(actorUserId, filters.buildingId);
  } else if (filters.clientId && actorUserId) {
    await assertClientAccess(actorUserId, filters.clientId);
  }

  if (filters.workOrderId) {
    const wo = await workOrderRepository.findById(filters.workOrderId);
    if (!wo) throw workOrderNotFoundError();
    if (filters.clientId && wo.clientId !== filters.clientId) throw woMaterialUsageClientMismatchError();
    if (filters.buildingId && wo.buildingId !== filters.buildingId) throw woMaterialUsageBuildingMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wo.buildingId);
  }

  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) throw inventoryItemNotFoundError();
    if (item.clientId !== filters.clientId) throw woMaterialUsageClientMismatchError();
  }

  const records = await inventoryWorkOrderMaterialUsageRepository.list({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    workOrderId: filters.workOrderId,
    warehouseId: filters.warehouseId,
    itemId: filters.itemId,
    materialRequestId: filters.materialRequestId,
    reservationId: filters.reservationId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    usedByUserId: filters.usedByUserId,
    reference: filters.reference,
  });

  const whIds = [...new Set(records.map(r => r.warehouseId))];
  const itemIds = [...new Set(records.map(r => r.itemId))];
  const woIds = [...new Set(records.map(r => r.workOrderId))];

  let whMap = new Map<string, { code: string; name: string; buildingId: string }>();
  let itemMap = new Map<string, { code: string; name: string; itemType: string }>();
  let woMap = new Map<string, { workOrderNumber: string; title: string; status: string }>();

  if (whIds.length || itemIds.length || woIds.length) {
    const pool = getPool();
    if (whIds.length) {
      const res = await pool.query('SELECT id, code, name, building_id FROM inventory_warehouses WHERE id = ANY($1)', [whIds]);
      for (const row of res.rows) whMap.set(row.id, { code: row.code, name: row.name, buildingId: row.building_id });
    }
    if (itemIds.length) {
      const res = await pool.query('SELECT id, code, name, item_type FROM inventory_items WHERE id = ANY($1)', [itemIds]);
      for (const row of res.rows) itemMap.set(row.id, { code: row.code, name: row.name, itemType: row.item_type });
    }
    if (woIds.length) {
      const res = await pool.query('SELECT id, work_order_number, title, status FROM work_orders WHERE id = ANY($1)', [woIds]);
      for (const row of res.rows) woMap.set(row.id, { workOrderNumber: row.work_order_number, title: row.title, status: row.status });
    }
  }

  return records.map(rec => {
    const pub: PublicWorkOrderMaterialUsage = {
      id: rec.id,
      clientId: rec.clientId,
      buildingId: rec.buildingId,
      workOrderId: rec.workOrderId,
      warehouseId: rec.warehouseId,
      itemId: rec.itemId,
      materialRequestId: rec.materialRequestId ?? null,
      reservationId: rec.reservationId ?? null,
      quantity: rec.quantity,
      uomId: rec.uomId ?? null,
      unitCost: rec.unitCost ?? null,
      totalCost: rec.totalCost ?? null,
      currency: rec.currency ?? null,
      costSource: rec.costSource ?? null,
      costReference: rec.costReference ?? null,
      stockMovementId: rec.stockMovementId ?? null,
      usedByUserId: rec.usedByUserId,
      usedAt: rec.usedAt.toISOString(),
      reference: rec.reference ?? null,
      notes: rec.notes ?? null,
      resultingQuantityOnHand: rec.resultingQuantityOnHand,
      resultingAvailableQuantity: rec.resultingAvailableQuantity,
      createdAt: rec.createdAt.toISOString(),
      workOrder: null,
      warehouse: null,
      item: null,
      resultingBalance: {
        quantityOnHand: rec.resultingQuantityOnHand,
        reservedQuantity: rec.resultingQuantityOnHand - rec.resultingAvailableQuantity,
        availableQuantity: rec.resultingAvailableQuantity,
      },
    };
    const wh = whMap.get(rec.warehouseId);
    if (wh) pub.warehouse = { id: rec.warehouseId, code: wh.code, name: wh.name, buildingId: wh.buildingId };
    const it = itemMap.get(rec.itemId);
    if (it) pub.item = { id: rec.itemId, code: it.code, name: it.name, itemType: it.itemType };
    const wo = woMap.get(rec.workOrderId);
    if (wo) pub.workOrder = { id: rec.workOrderId, workOrderNumber: wo.workOrderNumber, title: wo.title, status: wo.status };
    return pub;
  });
}

/**
 * CR-BE-MAT-01 PART 05 — deterministic Work Order material-cost aggregation:
 * Work Order → Material Usage → total material cost. Material cost only (no
 * labour/service cost); pure read — no inventory balance mutation.
 */
export async function getWorkOrderMaterialCostSummary(
  workOrderId: string,
  actorUserId?: string,
): Promise<WorkOrderMaterialCostSummary> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, workOrder.buildingId);
  }
  const summary = await inventoryWorkOrderMaterialUsageRepository.summarizeCostByWorkOrder(
    workOrder.id,
  );
  return { workOrderId: workOrder.id, ...summary };
}

export const inventoryWorkOrderMaterialUsageService = {
  resolveWorkOrderMaterialRequestId,
  getWorkOrderMaterialCostSummary,
  recordMaterialUsage,
  getUsageById,
  listUsages,
};

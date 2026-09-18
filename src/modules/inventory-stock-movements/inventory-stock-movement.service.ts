import { getPool } from '../../database';
import type { PoolClient } from 'pg';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import {
  stockMovementClientMismatchError,
  stockMovementImmutableError,
  stockMovementInsufficientStockError,
  stockMovementInvalidQuantityError,
  stockMovementNotFoundError,
  stockMovementWorkOrderBypassError,
  stockMovementHandymanMaterialBypassError,
} from './inventory-stock-movement.errors';
import { inventoryStockMovementRepository } from './inventory-stock-movement.repository';
import type {
  CreateStockMovementInput,
  PublicStockMovement,
  StockMovementFilters,
  NewStockMovement,
} from './inventory-stock-movement.types';

function toPublic(row: any): PublicStockMovement {
  const base: PublicStockMovement = {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    movementType: row.movementType,
    quantity: typeof row.quantity === 'number' ? row.quantity : Number(row.quantity),
    uomId: row.uomId ?? null,
    movementDate: row.movementDate instanceof Date ? row.movementDate.toISOString() : String(row.movementDate),
    reference: row.reference ?? null,
    source: row.source ?? null,
    performedByUserId: row.performedByUserId,
    notes: row.notes ?? null,
    resultingQuantityOnHand: typeof row.resultingQuantityOnHand === 'number' ? row.resultingQuantityOnHand : Number(row.resultingQuantityOnHand),
    resultingAvailableQuantity: typeof row.resultingAvailableQuantity === 'number' ? row.resultingAvailableQuantity : Number(row.resultingAvailableQuantity),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    warehouse: null,
    item: null,
    resultingBalance: {
      quantityOnHand: typeof row.resultingQuantityOnHand === 'number' ? row.resultingQuantityOnHand : Number(row.resultingQuantityOnHand),
      reservedQuantity: 0, // will be enriched if needed
      availableQuantity: typeof row.resultingAvailableQuantity === 'number' ? row.resultingAvailableQuantity : Number(row.resultingAvailableQuantity),
    },
  };

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
 * The existing Work Order usage flow emits `source = WORK_ORDER:{uuid}`.
 * Treating that exact, valid convention as a discriminator lets the generic
 * public STOCK_OUT route reject an identifiable Work Order bypass while
 * leaving unrelated generic sources untouched. Internal transaction callers
 * use `postStockMovementWithClient` and are not passed through this guard.
 */
function isWorkOrderMaterialSource(source: string | undefined): boolean {
  return /^WORK_ORDER:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    source?.trim() ?? '',
  );
}

/** Run-2 Handyman issue/return rows prove these internal movement sources. */
function isHandymanMaterialSource(source: string | undefined): boolean {
  return /^HANDYMAN_MATERIAL_(?:ISSUE|RETURN):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    source?.trim() ?? '',
  );
}

/**
 * Transaction-safe Stock In / Out.
 * Flow:
 * - Validate quantity >0
 * - Resolve warehouse + item, ensure same client
 * - BEGIN
 * - SELECT stock balance FOR UPDATE (or create if STOCK_IN and missing)
 * - For STOCK_OUT: check available >= quantity else insufficient
 * - Compute new on_hand, available
 * - UPDATE balance
 * - INSERT movement with resulting quantities
 * - COMMIT
 * Rollback on any error ensures consistency.
 */
export async function postStockMovement(
  input: CreateStockMovementInput,
): Promise<PublicStockMovement> {
  if (
    input.movementType === 'STOCK_OUT' &&
    isWorkOrderMaterialSource(input.source)
  ) {
    throw stockMovementWorkOrderBypassError();
  }
  if (isHandymanMaterialSource(input.source)) {
    throw stockMovementHandymanMaterialBypassError();
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { record, quantityOnHand, reservedQuantity, availableQuantity } =
      await postStockMovementWithClient(client, input);
    await client.query('COMMIT');

    // Fetch enriched
    const detailed = await inventoryStockMovementRepository.findByIdWithDetails(record.id);
    const pub = toPublic(detailed ?? record);
    // Enrich resultingBalance reserved
    pub.resultingBalance = {
      quantityOnHand,
      reservedQuantity,
      availableQuantity,
    };

    return pub;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Map unique violation if any (not expected for movements)
    throw e;
  } finally {
    client.release();
  }
}

/** Result of a stock movement executed inside a caller-owned transaction. */
export type StockMovementTxResult = {
  record: Awaited<ReturnType<typeof inventoryStockMovementRepository.createWithClient>>;
  quantityOnHand: number;
  reservedQuantity: number;
  availableQuantity: number;
};

/**
 * CR-BE-MAT-01 PART 01 — transaction-participating Stock In / Out core.
 *
 * Same validations and balance logic as `postStockMovement`, but executed on
 * a caller-provided client WITHOUT BEGIN/COMMIT so callers (e.g. Procurement
 * Receiving) can commit the movement atomically with their own record. This
 * parameterizes the existing engine — it does NOT create a second one.
 */
export async function postStockMovementWithClient(
  client: PoolClient,
  input: CreateStockMovementInput,
): Promise<StockMovementTxResult> {
  if (!input.quantity || input.quantity <= 0) {
    throw stockMovementInvalidQuantityError();
  }

  const consumesReservedAllocation =
    input.reservedQuantityToConsume !== undefined;
  if (
    consumesReservedAllocation &&
    (input.movementType !== 'STOCK_OUT' ||
      input.reservedQuantityToConsume !== input.quantity)
  ) {
    throw stockMovementInvalidQuantityError();
  }

  const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
  if (!warehouse) {
    throw inventoryWarehouseNotFoundError();
  }

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) {
    throw inventoryItemNotFoundError();
  }

  if (warehouse.clientId !== item.clientId) {
    throw stockMovementClientMismatchError();
  }

  if (input.performedByUserId) {
    await assertBuildingAccess(input.performedByUserId, warehouse.buildingId);
  }

    // Try to lock existing balance
    let balanceRes = await client.query(
      `SELECT id, client_id, building_id, warehouse_id, item_id,
              quantity_on_hand AS "quantityOnHand",
              reserved_quantity AS "reservedQuantity",
              available_quantity AS "availableQuantity"
       FROM inventory_stock_balances
       WHERE warehouse_id=$1 AND item_id=$2
       FOR UPDATE`,
      [input.warehouseId, input.itemId],
    );

    let balanceRow = balanceRes.rows[0];
    let isNewBalance = false;

    if (!balanceRow) {
      if (input.movementType === 'STOCK_OUT') {
        // No balance means 0 available
        throw stockMovementInsufficientStockError();
      }
      // Auto-initialize with 0 for STOCK_IN path before adding quantity
      isNewBalance = true;
      balanceRow = {
        id: null,
        client_id: warehouse.clientId,
        building_id: warehouse.buildingId,
        warehouse_id: warehouse.id,
        item_id: item.id,
        quantityOnHand: 0,
        reservedQuantity: 0,
        availableQuantity: 0,
      };
    }

    const oldOnHand = Number(balanceRow.quantityOnHand ?? balanceRow.quantity_on_hand ?? 0);
    const oldReserved = Number(balanceRow.reservedQuantity ?? balanceRow.reserved_quantity ?? 0);
    const oldAvailable = Number(balanceRow.availableQuantity ?? balanceRow.available_quantity ?? oldOnHand - oldReserved);

    let newOnHand: number;
    let newReserved = oldReserved;
    let newAvailable: number;

    if (input.movementType === 'STOCK_IN') {
      newOnHand = oldOnHand + input.quantity;
      newAvailable = newOnHand - newReserved;
    } else {
      // STOCK_OUT. An ordinary issue may consume only available stock. A
      // reservation-backed issue may consume its allocated reserved stock,
      // but still requires enough physical on-hand quantity.
      if (consumesReservedAllocation) {
        if (oldOnHand < input.quantity || oldReserved < input.quantity) {
          throw stockMovementInsufficientStockError();
        }
        newOnHand = oldOnHand - input.quantity;
        newReserved = oldReserved - input.quantity;
      } else {
        if (oldAvailable < input.quantity) {
          throw stockMovementInsufficientStockError();
        }
        newOnHand = oldOnHand - input.quantity;
      }
      newAvailable = newOnHand - newReserved;
    }

    if (newOnHand < 0 || newAvailable < 0) {
      throw stockMovementInvalidQuantityError();
    }

    // Upsert balance
    if (isNewBalance) {
      await client.query(
        `INSERT INTO inventory_stock_balances
           (id, client_id, building_id, warehouse_id, item_id, quantity_on_hand, reserved_quantity)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6)
         ON CONFLICT (warehouse_id, item_id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           reserved_quantity = EXCLUDED.reserved_quantity,
           updated_at = NOW()`,
        [
          warehouse.clientId,
          warehouse.buildingId,
          warehouse.id,
          item.id,
          newOnHand,
          newReserved,
        ],
      );
      // For simplicity we already have new values; but to be consistent use INSERT ... RETURNING would be better.
      // We'll update via first insert path: we inserted newOnHand directly, but we wanted to handle atomic.
      // Actually above inserts new balance already with newOnHand (not old). For new balance case, old was 0, new is qty.
      // So we need to set correct values: we did.
    } else {
      await client.query(
        `UPDATE inventory_stock_balances
         SET quantity_on_hand=$1, reserved_quantity=$2, updated_at=NOW()
         WHERE warehouse_id=$3 AND item_id=$4`,
        [newOnHand, newReserved, input.warehouseId, input.itemId],
      );
    }

    const movementDate = input.movementDate ? new Date(input.movementDate) : new Date();

    const newMovement: NewStockMovement = {
      clientId: warehouse.clientId,
      buildingId: warehouse.buildingId,
      warehouseId: warehouse.id,
      itemId: item.id,
      movementType: input.movementType,
      quantity: input.quantity,
      // PART 04 — snapshot the item's UOM at movement time so historical
      // reads never depend on the current (mutable) item UOM.
      uomId: item.uomId ?? null,
      movementDate,
      reference: input.reference?.trim() || null,
      source: input.source?.trim() || null,
      performedByUserId: input.performedByUserId,
      notes: input.notes?.trim() || null,
      resultingQuantityOnHand: newOnHand,
      resultingAvailableQuantity: newAvailable,
    };

    const created = await inventoryStockMovementRepository.createWithClient(client, newMovement);

    return {
      record: created,
      quantityOnHand: newOnHand,
      reservedQuantity: newReserved,
      availableQuantity: newAvailable,
    };
}

export async function getMovementById(id: string, actorUserId?: string): Promise<PublicStockMovement> {
  const detailed = await inventoryStockMovementRepository.findByIdWithDetails(id);
  if (!detailed) {
    throw stockMovementNotFoundError();
  }
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId ?? detailed.building_id);
  }
  return toPublic(detailed);
}

export async function listMovements(
  filters: StockMovementFilters,
  actorUserId?: string,
): Promise<PublicStockMovement[]> {
  // Isolation checks
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) {
      throw stockMovementClientMismatchError();
    }
    if (filters.buildingId && wh.buildingId !== filters.buildingId) {
      const { AppError, ERROR_CODES } = await import('../../shared/errors');
      throw new AppError({
        code: ERROR_CODES.INVENTORY_WAREHOUSE_CLIENT_MISMATCH,
        message: 'Warehouse does not belong to specified building.',
        statusCode: 400,
      });
    }
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  } else if (filters.buildingId) {
    if (actorUserId) await assertBuildingAccess(actorUserId, filters.buildingId);
  } else if (filters.clientId) {
    if (actorUserId) await assertClientAccess(actorUserId, filters.clientId);
  }

  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) throw inventoryItemNotFoundError();
    if (item.clientId !== filters.clientId) throw stockMovementClientMismatchError();
  }

  const records = await inventoryStockMovementRepository.list({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    warehouseId: filters.warehouseId,
    itemId: filters.itemId,
    movementType: filters.movementType as any,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    reference: filters.reference,
    performedByUserId: filters.performedByUserId,
  });

  // Batch enrich warehouse/item
  const whIds = [...new Set(records.map(r => r.warehouseId))];
  const itemIds = [...new Set(records.map(r => r.itemId))];
  let whMap = new Map<string, { code: string; name: string; buildingId: string }>();
  let itemMap = new Map<string, { code: string; name: string; itemType: string }>();

  if (whIds.length || itemIds.length) {
    const pool = getPool();
    if (whIds.length) {
      const res = await pool.query('SELECT id, code, name, building_id FROM inventory_warehouses WHERE id = ANY($1)', [whIds]);
      for (const row of res.rows) whMap.set(row.id, { code: row.code, name: row.name, buildingId: row.building_id });
    }
    if (itemIds.length) {
      const res = await pool.query('SELECT id, code, name, item_type FROM inventory_items WHERE id = ANY($1)', [itemIds]);
      for (const row of res.rows) itemMap.set(row.id, { code: row.code, name: row.name, itemType: row.item_type });
    }
  }

  return records.map(rec => {
    const pub: PublicStockMovement = {
      id: rec.id,
      clientId: rec.clientId,
      buildingId: rec.buildingId,
      warehouseId: rec.warehouseId,
      itemId: rec.itemId,
      movementType: rec.movementType as any,
      quantity: rec.quantity,
      uomId: rec.uomId ?? null,
      movementDate: rec.movementDate.toISOString(),
      reference: rec.reference ?? null,
      source: rec.source ?? null,
      performedByUserId: rec.performedByUserId,
      notes: rec.notes ?? null,
      resultingQuantityOnHand: rec.resultingQuantityOnHand,
      resultingAvailableQuantity: rec.resultingAvailableQuantity,
      createdAt: rec.createdAt.toISOString(),
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
    return pub;
  });
}

export async function assertImmutable(): Promise<never> {
  throw stockMovementImmutableError();
}

export const inventoryStockMovementService = {
  postStockMovement,
  postStockMovementWithClient,
  getMovementById,
  listMovements,
  assertImmutable,
};

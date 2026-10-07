import { getPool } from '../../database';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryStockMovementRepository } from '../inventory-stock-movements/inventory-stock-movement.repository';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import {
  adjustmentClientMismatchError,
  adjustmentInvalidQuantityError,
  adjustmentNegativeResultError,
  adjustmentNotFoundError,
  adjustmentReasonRequiredError,
} from './inventory-stock-adjustment.errors';
import { inventoryStockAdjustmentRepository } from './inventory-stock-adjustment.repository';
import type {
  CreateAdjustmentInput,
  PublicStockAdjustment,
  StockAdjustmentFilters,
  NewAdjustment,
} from './inventory-stock-adjustment.types';

function toPublic(row: any): PublicStockAdjustment {
  const base: PublicStockAdjustment = {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    adjustmentType: row.adjustmentType,
    quantity: typeof row.quantity === 'number' ? row.quantity : Number(row.quantity),
    reason: row.reason,
    adjustedAt: row.adjustedAt instanceof Date ? row.adjustedAt.toISOString() : String(row.adjustedAt),
    reference: row.reference ?? null,
    performedByUserId: row.performedByUserId,
    notes: row.notes ?? null,
    resultingQuantityOnHand: typeof row.resultingQuantityOnHand === 'number' ? row.resultingQuantityOnHand : Number(row.resultingQuantityOnHand),
    resultingAvailableQuantity: typeof row.resultingAvailableQuantity === 'number' ? row.resultingAvailableQuantity : Number(row.resultingAvailableQuantity),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    warehouse: null,
    item: null,
    resultingBalance: null,
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

  base.resultingBalance = {
    quantityOnHand: base.resultingQuantityOnHand,
    reservedQuantity: base.resultingQuantityOnHand - base.resultingAvailableQuantity,
    availableQuantity: base.resultingAvailableQuantity,
  };

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
 * Transaction-safe adjustment.
 * - INCREASE: new = old + qty
 * - DECREASE: new = old - qty, check available >= qty and new >=0 and new >= reserved
 * - SET_BALANCE: new = qty (target), check >=0 and >= reserved
 * - Reason required, quantity validation per type
 * - Balance update + adjustment record in same transaction with FOR UPDATE lock
 *
 * CR-BE-MAT-01 PART 03 — ledger completeness: any adjustment that changes the
 * on-hand quantity ALSO writes an `inventory_stock_movements` row (STOCK_IN
 * for a positive delta, STOCK_OUT for a negative delta; existing movement
 * types, no new engine) in the SAME transaction, carrying item, warehouse,
 * quantity delta, source `STOCK_ADJUSTMENT`, reference to the adjustment,
 * actor, timestamp, and resulting quantities. A no-op SET_BALANCE (delta 0)
 * changes no stock and therefore writes no movement.
 */
export async function postAdjustment(input: CreateAdjustmentInput): Promise<PublicStockAdjustment> {
  if (!input.reason || !input.reason.trim()) {
    throw adjustmentReasonRequiredError();
  }

  if (input.adjustmentType === 'SET_BALANCE') {
    if (input.quantity < 0) throw adjustmentInvalidQuantityError();
  } else {
    if (input.quantity <= 0) throw adjustmentInvalidQuantityError();
  }

  const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
  if (!warehouse) throw inventoryWarehouseNotFoundError();

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) throw inventoryItemNotFoundError();

  if (warehouse.clientId !== item.clientId) {
    throw adjustmentClientMismatchError();
  }

  if (input.performedByUserId) {
    await assertBuildingAccess(input.performedByUserId, warehouse.buildingId);
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let balanceRes = await client.query(
      `SELECT quantity_on_hand, reserved_quantity, available_quantity
       FROM inventory_stock_balances
       WHERE warehouse_id=$1 AND item_id=$2
       FOR UPDATE`,
      [input.warehouseId, input.itemId],
    );

    let oldOnHand = 0;
    let oldReserved = 0;
    let oldAvailable = 0;
    let exists = false;

    if (balanceRes.rows[0]) {
      oldOnHand = Number(balanceRes.rows[0].quantity_on_hand);
      oldReserved = Number(balanceRes.rows[0].reserved_quantity);
      oldAvailable = Number(balanceRes.rows[0].available_quantity);
      exists = true;
    }

    let newOnHand: number;

    if (input.adjustmentType === 'INCREASE') {
      newOnHand = oldOnHand + input.quantity;
    } else if (input.adjustmentType === 'DECREASE') {
      if (oldAvailable < input.quantity) {
        throw adjustmentNegativeResultError();
      }
      newOnHand = oldOnHand - input.quantity;
      if (newOnHand < 0) throw adjustmentNegativeResultError();
    } else {
      // SET_BALANCE
      newOnHand = input.quantity;
      if (newOnHand < oldReserved) {
        // Setting below reserved would make available negative
        throw adjustmentNegativeResultError();
      }
    }

    if (newOnHand < 0) throw adjustmentNegativeResultError();
    if (newOnHand < oldReserved) throw adjustmentNegativeResultError();

    const newAvailable = newOnHand - oldReserved;

    if (newAvailable < 0) throw adjustmentNegativeResultError();

    // Upsert balance
    if (exists) {
      await client.query(
        `UPDATE inventory_stock_balances
         SET quantity_on_hand=$1, reserved_quantity=$2, updated_at=NOW()
         WHERE warehouse_id=$3 AND item_id=$4`,
        [newOnHand, oldReserved, input.warehouseId, input.itemId],
      );
    } else {
      await client.query(
        `INSERT INTO inventory_stock_balances
           (id, client_id, building_id, warehouse_id, item_id, quantity_on_hand, reserved_quantity)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6)
         ON CONFLICT (warehouse_id, item_id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           reserved_quantity = EXCLUDED.reserved_quantity,
           updated_at = NOW()`,
        [warehouse.clientId, warehouse.buildingId, warehouse.id, item.id, newOnHand, oldReserved],
      );
    }

    const adjustedAt = input.adjustedAt ? new Date(input.adjustedAt) : new Date();

    const newAdj: NewAdjustment = {
      clientId: warehouse.clientId,
      buildingId: warehouse.buildingId,
      warehouseId: warehouse.id,
      itemId: item.id,
      adjustmentType: input.adjustmentType,
      quantity: input.quantity,
      reason: input.reason.trim(),
      adjustedAt,
      reference: input.reference?.trim() || null,
      performedByUserId: input.performedByUserId,
      notes: input.notes?.trim() || null,
      resultingQuantityOnHand: newOnHand,
      resultingAvailableQuantity: newAvailable,
    };

    const created = await inventoryStockAdjustmentRepository.createWithClient(client, newAdj);

    // PART 03 — the movement ledger must reflect every balance change.
    const delta = newOnHand - oldOnHand;
    if (delta !== 0) {
      await inventoryStockMovementRepository.createWithClient(client, {
        clientId: warehouse.clientId,
        buildingId: warehouse.buildingId,
        warehouseId: warehouse.id,
        itemId: item.id,
        movementType: delta > 0 ? 'STOCK_IN' : 'STOCK_OUT',
        quantity: Math.abs(delta),
        // PART 04 — UOM snapshot at adjustment time.
        uomId: item.uomId ?? null,
        movementDate: adjustedAt,
        reference: `STOCK_ADJUSTMENT:${created.id}`,
        source: 'STOCK_ADJUSTMENT',
        performedByUserId: input.performedByUserId,
        notes: input.reason.trim(),
        resultingQuantityOnHand: newOnHand,
        resultingAvailableQuantity: newAvailable,
      });
    }

    await client.query('COMMIT');

    const detailed = await inventoryStockAdjustmentRepository.findByIdWithDetails(created.id);
    return toPublic(detailed ?? created);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function getAdjustmentById(id: string, actorUserId?: string): Promise<PublicStockAdjustment> {
  const detailed = await inventoryStockAdjustmentRepository.findByIdWithDetails(id);
  if (!detailed) throw adjustmentNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId);
  }
  return toPublic(detailed);
}

export async function listAdjustments(
  filters: StockAdjustmentFilters,
  actorUserId?: string,
): Promise<PublicStockAdjustment[]> {
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw adjustmentClientMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  } else if (filters.buildingId) {
    if (actorUserId) await assertBuildingAccess(actorUserId, filters.buildingId);
  } else if (filters.clientId && actorUserId) {
    await assertClientAccess(actorUserId, filters.clientId);
  }

  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) throw inventoryItemNotFoundError();
    if (item.clientId !== filters.clientId) throw adjustmentClientMismatchError();
  }

  const records = await inventoryStockAdjustmentRepository.list({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    warehouseId: filters.warehouseId,
    itemId: filters.itemId,
    adjustmentType: filters.adjustmentType as any,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    reference: filters.reference,
    performedByUserId: filters.performedByUserId,
    reason: filters.reason,
  });

  // Enrich
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
    const pub: PublicStockAdjustment = {
      id: rec.id,
      clientId: rec.clientId,
      buildingId: rec.buildingId,
      warehouseId: rec.warehouseId,
      itemId: rec.itemId,
      adjustmentType: rec.adjustmentType as any,
      quantity: rec.quantity,
      reason: rec.reason,
      adjustedAt: rec.adjustedAt.toISOString(),
      reference: rec.reference ?? null,
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

export const inventoryStockAdjustmentService = {
  postAdjustment,
  getAdjustmentById,
  listAdjustments,
};

import { getPool } from '../../database';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import {
  transferClientMismatchError,
  transferInsufficientStockError,
  transferInvalidQuantityError,
  transferNotFoundError,
  transferSameWarehouseError,
} from './inventory-stock-transfer.errors';
import { inventoryStockTransferRepository } from './inventory-stock-transfer.repository';
import type {
  CreateTransferInput,
  PublicStockTransfer,
  StockTransferFilters,
  NewTransfer,
} from './inventory-stock-transfer.types';

function toPublic(row: any): PublicStockTransfer {
  const base: PublicStockTransfer = {
    id: row.id,
    clientId: row.clientId,
    sourceWarehouseId: row.sourceWarehouseId,
    destinationWarehouseId: row.destinationWarehouseId,
    sourceBuildingId: row.sourceBuildingId,
    destinationBuildingId: row.destinationBuildingId,
    itemId: row.itemId,
    quantity: typeof row.quantity === 'number' ? row.quantity : Number(row.quantity),
    transferDate: row.transferDate instanceof Date ? row.transferDate.toISOString() : String(row.transferDate),
    status: row.status,
    reference: row.reference ?? null,
    performedByUserId: row.performedByUserId,
    notes: row.notes ?? null,
    resultingSourceOnHand: typeof row.resultingSourceOnHand === 'number' ? row.resultingSourceOnHand : Number(row.resultingSourceOnHand),
    resultingSourceAvailable: typeof row.resultingSourceAvailable === 'number' ? row.resultingSourceAvailable : Number(row.resultingSourceAvailable),
    resultingDestinationOnHand: typeof row.resultingDestinationOnHand === 'number' ? row.resultingDestinationOnHand : Number(row.resultingDestinationOnHand),
    resultingDestinationAvailable: typeof row.resultingDestinationAvailable === 'number' ? row.resultingDestinationAvailable : Number(row.resultingDestinationAvailable),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    sourceWarehouse: null,
    destinationWarehouse: null,
    item: null,
    resultingSourceBalance: null,
    resultingDestinationBalance: null,
  };

  if (row.sourceWarehouseCode) {
    base.sourceWarehouse = {
      id: row.sourceWarehouseId,
      code: row.sourceWarehouseCode,
      name: row.sourceWarehouseName,
      buildingId: row.sourceBuildingId,
    };
  }
  if (row.destinationWarehouseCode) {
    base.destinationWarehouse = {
      id: row.destinationWarehouseId,
      code: row.destinationWarehouseCode,
      name: row.destinationWarehouseName,
      buildingId: row.destinationBuildingId,
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

  base.resultingSourceBalance = {
    quantityOnHand: base.resultingSourceOnHand,
    reservedQuantity: base.resultingSourceOnHand - base.resultingSourceAvailable,
    availableQuantity: base.resultingSourceAvailable,
  };
  base.resultingDestinationBalance = {
    quantityOnHand: base.resultingDestinationOnHand,
    reservedQuantity: base.resultingDestinationOnHand - base.resultingDestinationAvailable,
    availableQuantity: base.resultingDestinationAvailable,
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
 * Transaction-safe transfer: source decrease, destination increase, transfer record, two stock movements.
 * Steps:
 * - Validate different warehouses, positive qty
 * - Resolve warehouses same client, item same client
 * - BEGIN, SELECT both balances FOR UPDATE ordered by warehouse_id to avoid deadlock
 * - Check source available >= qty else insufficient
 * - Compute new balances
 * - UPDATE source balance (must exist, else insufficient)
 * - INSERT or UPDATE destination balance
 * - INSERT transfer record with resulting balances
 * - INSERT two stock movements: STOCK_OUT source, STOCK_IN destination with reference=transfer.id
 * - COMMIT
 */
export async function createTransfer(
  input: CreateTransferInput,
): Promise<PublicStockTransfer> {
  if (input.sourceWarehouseId === input.destinationWarehouseId) {
    throw transferSameWarehouseError();
  }
  if (!input.quantity || input.quantity <= 0) {
    throw transferInvalidQuantityError();
  }

  const sourceWh = await inventoryWarehouseRepository.findById(input.sourceWarehouseId);
  if (!sourceWh) throw inventoryWarehouseNotFoundError();
  const destWh = await inventoryWarehouseRepository.findById(input.destinationWarehouseId);
  if (!destWh) throw inventoryWarehouseNotFoundError();

  if (sourceWh.clientId !== destWh.clientId) {
    throw transferClientMismatchError();
  }

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) throw inventoryItemNotFoundError();
  if (item.clientId !== sourceWh.clientId) {
    throw transferClientMismatchError();
  }

  if (input.performedByUserId) {
    await assertBuildingAccess(input.performedByUserId, sourceWh.buildingId);
    await assertBuildingAccess(input.performedByUserId, destWh.buildingId);
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock balances in deterministic order to avoid deadlock (order by warehouse_id)
    const [firstWhId, secondWhId] =
      sourceWh.id < destWh.id ? [sourceWh.id, destWh.id] : [destWh.id, sourceWh.id];

    const firstBalanceRes = await client.query(
      `SELECT warehouse_id, quantity_on_hand, reserved_quantity, available_quantity
       FROM inventory_stock_balances
       WHERE warehouse_id=$1 AND item_id=$2
       FOR UPDATE`,
      [firstWhId, input.itemId],
    );
    const secondBalanceRes = await client.query(
      `SELECT warehouse_id, quantity_on_hand, reserved_quantity, available_quantity
       FROM inventory_stock_balances
       WHERE warehouse_id=$1 AND item_id=$2
       FOR UPDATE`,
      [secondWhId, input.itemId],
    );

    const balancesByWh = new Map<string, { onHand: number; reserved: number; available: number; exists: boolean }>();
    for (const r of [firstBalanceRes.rows[0], secondBalanceRes.rows[0]]) {
      if (r) {
        balancesByWh.set(r.warehouse_id, {
          onHand: Number(r.quantity_on_hand),
          reserved: Number(r.reserved_quantity),
          available: Number(r.available_quantity),
          exists: true,
        });
      }
    }

    const sourceBal = balancesByWh.get(sourceWh.id);
    if (!sourceBal) {
      throw transferInsufficientStockError();
    }
    if (sourceBal.available < input.quantity) {
      throw transferInsufficientStockError();
    }

    const destBal = balancesByWh.get(destWh.id) ?? { onHand: 0, reserved: 0, available: 0, exists: false };

    const newSourceOnHand = sourceBal.onHand - input.quantity;
    const newSourceAvailable = newSourceOnHand - sourceBal.reserved;

    const newDestOnHand = destBal.onHand + input.quantity;
    const newDestAvailable = newDestOnHand - destBal.reserved;

    if (newSourceOnHand < 0 || newSourceAvailable < 0) {
      throw transferInsufficientStockError();
    }

    // Update source balance
    await client.query(
      `UPDATE inventory_stock_balances
       SET quantity_on_hand=$1, reserved_quantity=$2, updated_at=NOW()
       WHERE warehouse_id=$3 AND item_id=$4`,
      [newSourceOnHand, sourceBal.reserved, sourceWh.id, input.itemId],
    );

    // Upsert destination balance
    if (destBal.exists) {
      await client.query(
        `UPDATE inventory_stock_balances
         SET quantity_on_hand=$1, reserved_quantity=$2, updated_at=NOW()
         WHERE warehouse_id=$3 AND item_id=$4`,
        [newDestOnHand, destBal.reserved, destWh.id, input.itemId],
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
        [destWh.clientId, destWh.buildingId, destWh.id, input.itemId, newDestOnHand, destBal.reserved],
      );
    }

    const transferDate = input.transferDate ? new Date(input.transferDate) : new Date();

    const newTransfer: NewTransfer = {
      clientId: sourceWh.clientId,
      sourceWarehouseId: sourceWh.id,
      destinationWarehouseId: destWh.id,
      sourceBuildingId: sourceWh.buildingId,
      destinationBuildingId: destWh.buildingId,
      itemId: item.id,
      quantity: input.quantity,
      transferDate,
      status: 'COMPLETED',
      reference: input.reference?.trim() || null,
      performedByUserId: input.performedByUserId,
      notes: input.notes?.trim() || null,
      resultingSourceOnHand: newSourceOnHand,
      resultingSourceAvailable: newSourceAvailable,
      resultingDestinationOnHand: newDestOnHand,
      resultingDestinationAvailable: newDestAvailable,
    };

    const createdTransfer = await inventoryStockTransferRepository.createWithClient(client, newTransfer);

    // Create two stock movements for audit trail
    const { randomUUID } = await import('node:crypto');
    const movementBase = {
      reference: input.reference?.trim() || createdTransfer.id,
      source: `TRANSFER:${createdTransfer.id}`,
    };

    // Source STOCK_OUT
    await client.query(
      `INSERT INTO inventory_stock_movements
         (id, client_id, building_id, warehouse_id, item_id, movement_type, quantity, uom_id, movement_date, reference, source, performed_by_user_id, notes, resulting_quantity_on_hand, resulting_available_quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        randomUUID(),
        sourceWh.clientId,
        sourceWh.buildingId,
        sourceWh.id,
        item.id,
        'STOCK_OUT',
        input.quantity,
        item.uomId ?? null,
        transferDate,
        movementBase.reference,
        movementBase.source,
        input.performedByUserId,
        `Transfer to ${destWh.code}`,
        newSourceOnHand,
        newSourceAvailable,
      ],
    );

    // Destination STOCK_IN
    await client.query(
      `INSERT INTO inventory_stock_movements
         (id, client_id, building_id, warehouse_id, item_id, movement_type, quantity, uom_id, movement_date, reference, source, performed_by_user_id, notes, resulting_quantity_on_hand, resulting_available_quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        randomUUID(),
        destWh.clientId,
        destWh.buildingId,
        destWh.id,
        item.id,
        'STOCK_IN',
        input.quantity,
        item.uomId ?? null,
        transferDate,
        movementBase.reference,
        movementBase.source,
        input.performedByUserId,
        `Transfer from ${sourceWh.code}`,
        newDestOnHand,
        newDestAvailable,
      ],
    );

    await client.query('COMMIT');

    const detailed = await inventoryStockTransferRepository.findByIdWithDetails(createdTransfer.id);
    return toPublic(detailed ?? createdTransfer);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function getTransferById(id: string, actorUserId?: string): Promise<PublicStockTransfer> {
  const detailed = await inventoryStockTransferRepository.findByIdWithDetails(id);
  if (!detailed) throw transferNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.sourceBuildingId);
    await assertBuildingAccess(actorUserId, detailed.destinationBuildingId);
  }
  return toPublic(detailed);
}

export async function listTransfers(
  filters: StockTransferFilters,
  actorUserId?: string,
): Promise<PublicStockTransfer[]> {
  if (filters.sourceWarehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.sourceWarehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw transferClientMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  }
  if (filters.destinationWarehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.destinationWarehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw transferClientMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  }
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw transferClientMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  }
  if (filters.buildingId && actorUserId) {
    await assertBuildingAccess(actorUserId, filters.buildingId);
  }
  if (filters.clientId && actorUserId && !filters.buildingId && !filters.warehouseId && !filters.sourceWarehouseId && !filters.destinationWarehouseId) {
    await assertClientAccess(actorUserId, filters.clientId);
  }
  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) throw inventoryItemNotFoundError();
    if (item.clientId !== filters.clientId) throw transferClientMismatchError();
  }

  const records = await inventoryStockTransferRepository.list({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    sourceWarehouseId: filters.sourceWarehouseId,
    destinationWarehouseId: filters.destinationWarehouseId,
    warehouseId: filters.warehouseId,
    itemId: filters.itemId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    reference: filters.reference,
    status: filters.status as any,
    performedByUserId: filters.performedByUserId,
  });

  // Enrich
  const whIds = [...new Set(records.flatMap(r => [r.sourceWarehouseId, r.destinationWarehouseId]))];
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
    const pub: PublicStockTransfer = {
      id: rec.id,
      clientId: rec.clientId,
      sourceWarehouseId: rec.sourceWarehouseId,
      destinationWarehouseId: rec.destinationWarehouseId,
      sourceBuildingId: rec.sourceBuildingId,
      destinationBuildingId: rec.destinationBuildingId,
      itemId: rec.itemId,
      quantity: rec.quantity,
      transferDate: rec.transferDate.toISOString(),
      status: rec.status,
      reference: rec.reference ?? null,
      performedByUserId: rec.performedByUserId,
      notes: rec.notes ?? null,
      resultingSourceOnHand: rec.resultingSourceOnHand,
      resultingSourceAvailable: rec.resultingSourceAvailable,
      resultingDestinationOnHand: rec.resultingDestinationOnHand,
      resultingDestinationAvailable: rec.resultingDestinationAvailable,
      createdAt: rec.createdAt.toISOString(),
      sourceWarehouse: null,
      destinationWarehouse: null,
      item: null,
      resultingSourceBalance: {
        quantityOnHand: rec.resultingSourceOnHand,
        reservedQuantity: rec.resultingSourceOnHand - rec.resultingSourceAvailable,
        availableQuantity: rec.resultingSourceAvailable,
      },
      resultingDestinationBalance: {
        quantityOnHand: rec.resultingDestinationOnHand,
        reservedQuantity: rec.resultingDestinationOnHand - rec.resultingDestinationAvailable,
        availableQuantity: rec.resultingDestinationAvailable,
      },
    };
    const sw = whMap.get(rec.sourceWarehouseId);
    if (sw) pub.sourceWarehouse = { id: rec.sourceWarehouseId, code: sw.code, name: sw.name, buildingId: sw.buildingId };
    const dw = whMap.get(rec.destinationWarehouseId);
    if (dw) pub.destinationWarehouse = { id: rec.destinationWarehouseId, code: dw.code, name: dw.name, buildingId: dw.buildingId };
    const it = itemMap.get(rec.itemId);
    if (it) pub.item = { id: rec.itemId, code: it.code, name: it.name, itemType: it.itemType };
    return pub;
  });
}

export const inventoryStockTransferService = {
  createTransfer,
  getTransferById,
  listTransfers,
};

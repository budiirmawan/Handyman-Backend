import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { getPool } from '../../database';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryStockMovementRepository } from '../inventory-stock-movements/inventory-stock-movement.repository';
import {
  stockBalanceAlreadyExistsError,
  stockBalanceClientMismatchError,
  stockBalanceInitActorRequiredError,
  stockBalanceNegativeQuantityError,
  stockBalanceNotFoundError,
  stockBalanceReservedExceedsError,
} from './inventory-stock-balance.errors';
import { inventoryStockBalanceRepository } from './inventory-stock-balance.repository';
import type {
  CreateStockBalanceInput,
  InventoryStockBalanceRecord,
  NewStockBalance,
  PublicInventoryStockBalance,
  StockBalanceListFilters,
} from './inventory-stock-balance.types';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';

function toPublic(row: any): PublicInventoryStockBalance {
  // row may be enriched or simple
  const rec: InventoryStockBalanceRecord = row.quantityOnHand !== undefined && typeof row.quantityOnHand === 'number'
    ? row
    : {
        id: row.id,
        clientId: row.clientId,
        buildingId: row.buildingId,
        warehouseId: row.warehouseId,
        itemId: row.itemId,
        quantityOnHand: Number(row.quantityOnHand ?? 0),
        reservedQuantity: Number(row.reservedQuantity ?? 0),
        availableQuantity: Number(row.availableQuantity ?? (Number(row.quantityOnHand ?? 0) - Number(row.reservedQuantity ?? 0))),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };

  const base: PublicInventoryStockBalance = {
    id: rec.id,
    clientId: rec.clientId,
    buildingId: rec.buildingId,
    warehouseId: rec.warehouseId,
    itemId: rec.itemId,
    quantityOnHand: rec.quantityOnHand,
    reservedQuantity: rec.reservedQuantity,
    availableQuantity: rec.availableQuantity,
    createdAt: rec.createdAt instanceof Date ? rec.createdAt.toISOString() : String(rec.createdAt),
    updatedAt: rec.updatedAt instanceof Date ? rec.updatedAt.toISOString() : String(rec.updatedAt),
    warehouse: null,
    item: null,
  };

  if (row.warehouseCode) {
    base.warehouse = {
      id: rec.warehouseId,
      code: row.warehouseCode,
      name: row.warehouseName,
      buildingId: row.warehouseBuildingId ?? rec.buildingId,
    };
  }
  if (row.itemCode) {
    base.item = {
      id: rec.itemId,
      code: row.itemCode,
      name: row.itemName,
      itemType: row.itemType,
      uomId: row.itemUomId ?? null,
    };
  }

  return base;
}

function toPublicSimple(rec: InventoryStockBalanceRecord): PublicInventoryStockBalance {
  return {
    id: rec.id,
    clientId: rec.clientId,
    buildingId: rec.buildingId,
    warehouseId: rec.warehouseId,
    itemId: rec.itemId,
    quantityOnHand: rec.quantityOnHand,
    reservedQuantity: rec.reservedQuantity,
    availableQuantity: rec.availableQuantity,
    createdAt: rec.createdAt.toISOString(),
    updatedAt: rec.updatedAt.toISOString(),
    warehouse: null,
    item: null,
  };
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
 * Initialize Stock Balance per Item+Warehouse.
 * Validation order:
 * 1. Warehouse exists → else 404 INVENTORY_WAREHOUSE_NOT_FOUND
 * 2. Item exists → else 404 INVENTORY_ITEM_NOT_FOUND
 * 3. Client mismatch Item vs Warehouse → 400 CLIENT_MISMATCH
 * 4. Duplicate warehouse+item → 409 ALREADY_EXISTS
 * 5. Quantity negative → 400 NEGATIVE
 * 6. Reserved > onHand → 400 RESERVED_EXCEEDS
 */
export async function initializeStockBalance(
  input: CreateStockBalanceInput,
  actorUserId?: string,
): Promise<PublicInventoryStockBalance> {
  const quantityOnHand = input.quantityOnHand ?? 0;
  const reservedQuantity = input.reservedQuantity ?? 0;

  if (quantityOnHand < 0 || reservedQuantity < 0) {
    throw stockBalanceNegativeQuantityError();
  }
  if (reservedQuantity > quantityOnHand) {
    throw stockBalanceReservedExceedsError();
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
    throw stockBalanceClientMismatchError();
  }

  if (actorUserId) {
    await assertBuildingAccess(actorUserId, warehouse.buildingId);
  }

  const existing = await inventoryStockBalanceRepository.findByWarehouseAndItem(
    input.warehouseId,
    input.itemId,
  );
  if (existing) {
    throw stockBalanceAlreadyExistsError();
  }

  const newBal: NewStockBalance = {
    clientId: warehouse.clientId,
    buildingId: warehouse.buildingId,
    warehouseId: warehouse.id,
    itemId: item.id,
    quantityOnHand,
    reservedQuantity,
  };

  // CR-BE-MAT-01 PART 03 — ledger completeness. A zero-quantity
  // initialization changes no stock and stays movement-free (compatible).
  if (quantityOnHand === 0) {
    try {
      const created = await inventoryStockBalanceRepository.create(newBal);
      const detailed = await inventoryStockBalanceRepository.findByIdWithDetails(created.id);
      return toPublic(detailed ?? created);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw stockBalanceAlreadyExistsError();
      }
      throw e;
    }
  }

  // Non-zero initialization is a real stock change: it must enter through the
  // existing movement ledger (STOCK_IN, source BALANCE_INITIALIZATION) and
  // commit atomically with the balance row. An unattributable seed is
  // rejected — silent non-zero initialization outside the ledger is no
  // longer possible.
  if (!actorUserId) {
    throw stockBalanceInitActorRequiredError();
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await inventoryStockBalanceRepository.createWithClient(client, newBal);
    await inventoryStockMovementRepository.createWithClient(client, {
      clientId: warehouse.clientId,
      buildingId: warehouse.buildingId,
      warehouseId: warehouse.id,
      itemId: item.id,
      movementType: 'STOCK_IN',
      quantity: quantityOnHand,
      // PART 04 — UOM snapshot at initialization time.
      uomId: item.uomId ?? null,
      movementDate: new Date(),
      reference: `BALANCE_INIT:${created.id}`,
      source: 'BALANCE_INITIALIZATION',
      performedByUserId: actorUserId,
      notes: 'Initial stock balance',
      resultingQuantityOnHand: quantityOnHand,
      resultingAvailableQuantity: quantityOnHand - reservedQuantity,
    });
    await client.query('COMMIT');
    const detailed = await inventoryStockBalanceRepository.findByIdWithDetails(created.id);
    return toPublic(detailed ?? created);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(e)) {
      throw stockBalanceAlreadyExistsError();
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function getStockBalanceById(
  id: string,
  actorUserId?: string,
): Promise<PublicInventoryStockBalance> {
  const detailed = await inventoryStockBalanceRepository.findByIdWithDetails(id);
  if (!detailed) {
    throw stockBalanceNotFoundError();
  }
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId ?? detailed.building_id);
  }
  return toPublic(detailed);
}

export async function listStockBalances(
  filters: StockBalanceListFilters,
  actorUserId?: string,
): Promise<PublicInventoryStockBalance[]> {
  // Enforce isolation: if buildingId provided, check building access; if clientId, check client access; if warehouseId, resolve warehouse building then check
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) {
      throw inventoryWarehouseNotFoundError();
    }
    if (filters.clientId && wh.clientId !== filters.clientId) {
      throw stockBalanceClientMismatchError();
    }
    if (filters.buildingId && wh.buildingId !== filters.buildingId) {
      const { AppError, ERROR_CODES } = await import('../../shared/errors');
      throw new AppError({
        code: ERROR_CODES.INVENTORY_WAREHOUSE_CLIENT_MISMATCH,
        message: 'Warehouse does not belong to specified building.',
        statusCode: 400,
      });
    }
    if (actorUserId) {
      await assertBuildingAccess(actorUserId, wh.buildingId);
    }
  } else if (filters.buildingId) {
    if (actorUserId) {
      await assertBuildingAccess(actorUserId, filters.buildingId);
    }
  } else if (filters.clientId) {
    if (actorUserId) {
      await assertClientAccess(actorUserId, filters.clientId);
    }
  }

  // If itemId provided, validate existence for better error? Optional — if item not found, return empty or 404? We'll 404 for strictness when item filter alone? Keep permissive for list, but check client mismatch if both clientId and itemId provided
  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) {
      throw inventoryItemNotFoundError();
    }
    if (item.clientId !== filters.clientId) {
      throw stockBalanceClientMismatchError();
    }
  }

  const records = await inventoryStockBalanceRepository.list({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    warehouseId: filters.warehouseId,
    itemId: filters.itemId,
  });

  // Enrichment batch for warehouse and item codes
  const whIds = [...new Set(records.map(r => r.warehouseId))];
  const itemIds = [...new Set(records.map(r => r.itemId))];
  let whMap = new Map<string, { code: string; name: string; buildingId: string }>();
  let itemMap = new Map<string, { code: string; name: string; itemType: string; uomId: string | null }>();

  if (whIds.length || itemIds.length) {
    const { getPool } = await import('../../database');
    if (whIds.length) {
      const res = await getPool().query(
        'SELECT id, code, name, building_id FROM inventory_warehouses WHERE id = ANY($1)',
        [whIds],
      );
      for (const row of res.rows) {
        whMap.set(row.id, { code: row.code, name: row.name, buildingId: row.building_id });
      }
    }
    if (itemIds.length) {
      const res = await getPool().query(
        'SELECT id, code, name, item_type, uom_id FROM inventory_items WHERE id = ANY($1)',
        [itemIds],
      );
      for (const row of res.rows) {
        itemMap.set(row.id, { code: row.code, name: row.name, itemType: row.item_type, uomId: row.uom_id });
      }
    }
  }

  return records.map(rec => {
    const pub = toPublicSimple(rec);
    const wh = whMap.get(rec.warehouseId);
    if (wh) {
      pub.warehouse = { id: rec.warehouseId, code: wh.code, name: wh.name, buildingId: wh.buildingId };
    }
    const it = itemMap.get(rec.itemId);
    if (it) {
      pub.item = { id: rec.itemId, code: it.code, name: it.name, itemType: it.itemType, uomId: it.uomId };
    }
    return pub;
  });
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'inventory_stock_balances_warehouse_item_unique';
}

export const inventoryStockBalanceService = {
  initializeStockBalance,
  getStockBalanceById,
  listStockBalances,
};

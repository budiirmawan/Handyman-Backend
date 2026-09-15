import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import {
  minimumStockAlreadyExistsError,
  minimumStockClientMismatchError,
  minimumStockInvalidQuantityError,
  minimumStockNotFoundError,
} from './inventory-minimum-stock.errors';
import { inventoryMinimumStockRepository } from './inventory-minimum-stock.repository';
import type {
  CreateMinimumStockInput,
  MinimumStockFilters,
  NewMinimumStock,
  PublicMinimumStock,
  UpdateMinimumStockInput,
  StockReadiness,
} from './inventory-minimum-stock.types';

function computeReadiness(available: number | null, minimum: number, status: string): StockReadiness {
  if (status !== 'ACTIVE') {
    return 'UNKNOWN';
  }
  if (available === null) {
    // No balance -> treat as 0 available => LOW if minimum >0
    return minimum > 0 ? 'LOW_STOCK' : 'OK';
  }
  return available < minimum ? 'LOW_STOCK' : 'OK';
}

function toPublic(row: any): PublicMinimumStock {
  const available = row.balanceAvailable ?? null;
  const readiness = computeReadiness(available, row.minimumQuantity, row.status);

  const base: PublicMinimumStock = {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    minimumQuantity: typeof row.minimumQuantity === 'number' ? row.minimumQuantity : Number(row.minimumQuantity),
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    warehouse: null,
    item: null,
    currentBalance: null,
    readiness,
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

  if (row.balanceAvailable !== undefined) {
    if (row.balanceAvailable === null) {
      base.currentBalance = null;
    } else {
      base.currentBalance = {
        quantityOnHand: row.balanceOnHand,
        reservedQuantity: row.balanceReserved ?? 0,
        availableQuantity: row.balanceAvailable,
      };
    }
  } else if (row.balanceOnHand !== undefined && row.balanceOnHand !== null) {
    base.currentBalance = {
      quantityOnHand: row.balanceOnHand,
      reservedQuantity: row.balanceReserved ?? 0,
      availableQuantity: row.balanceAvailable,
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

export async function setMinimumStock(
  input: CreateMinimumStockInput,
  actorUserId?: string,
): Promise<PublicMinimumStock> {
  if (input.minimumQuantity <= 0) {
    throw minimumStockInvalidQuantityError();
  }

  const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
  if (!warehouse) throw inventoryWarehouseNotFoundError();

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) throw inventoryItemNotFoundError();

  if (warehouse.clientId !== item.clientId) {
    throw minimumStockClientMismatchError();
  }

  if (actorUserId) {
    await assertBuildingAccess(actorUserId, warehouse.buildingId);
  }

  const existing = await inventoryMinimumStockRepository.findByWarehouseAndItem(
    input.warehouseId,
    input.itemId,
  );
  if (existing) {
    throw minimumStockAlreadyExistsError();
  }

  const newRec: NewMinimumStock = {
    clientId: warehouse.clientId,
    buildingId: warehouse.buildingId,
    warehouseId: warehouse.id,
    itemId: item.id,
    minimumQuantity: input.minimumQuantity,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const created = await inventoryMinimumStockRepository.create(newRec);
    const detailed = await inventoryMinimumStockRepository.findByIdWithDetails(created.id);
    return toPublic(detailed ?? created);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw minimumStockAlreadyExistsError();
    }
    throw e;
  }
}

export async function updateMinimumStock(
  id: string,
  input: UpdateMinimumStockInput,
  actorUserId?: string,
): Promise<PublicMinimumStock> {
  if (input.minimumQuantity !== undefined && input.minimumQuantity <= 0) {
    throw minimumStockInvalidQuantityError();
  }

  const existing = await inventoryMinimumStockRepository.findById(id);
  if (!existing) throw minimumStockNotFoundError();

  if (actorUserId) {
    await assertBuildingAccess(actorUserId, existing.buildingId);
  }

  const updated = await inventoryMinimumStockRepository.update(id, input);
  if (!updated) throw minimumStockNotFoundError();

  const detailed = await inventoryMinimumStockRepository.findByIdWithDetails(id);
  return toPublic(detailed ?? updated);
}

export async function getMinimumStockById(id: string, actorUserId?: string): Promise<PublicMinimumStock> {
  const detailed = await inventoryMinimumStockRepository.findByIdWithDetails(id);
  if (!detailed) throw minimumStockNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId);
  }
  return toPublic(detailed);
}

export async function listMinimumStocks(
  filters: MinimumStockFilters,
  actorUserId?: string,
): Promise<PublicMinimumStock[]> {
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw minimumStockClientMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  } else if (filters.buildingId) {
    if (actorUserId) await assertBuildingAccess(actorUserId, filters.buildingId);
  } else if (filters.clientId && actorUserId) {
    await assertClientAccess(actorUserId, filters.clientId);
  }

  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) throw inventoryItemNotFoundError();
    if (item.clientId !== filters.clientId) throw minimumStockClientMismatchError();
  }

  const rows = await inventoryMinimumStockRepository.listWithDetails({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    warehouseId: filters.warehouseId,
    itemId: filters.itemId,
    status: filters.status as any,
  });

  let filtered = rows.map(toPublic);

  if (filters.readiness) {
    filtered = filtered.filter(r => r.readiness === filters.readiness);
  }

  return filtered;
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'inventory_minimum_stocks_warehouse_item_unique';
}

export const inventoryMinimumStockService = {
  setMinimumStock,
  updateMinimumStock,
  getMinimumStockById,
  listMinimumStocks,
};

import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { inventoryWarehouseRepository } from '../inventory-warehouses';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses/inventory-warehouse.errors';
import { consumableReadinessRepository } from '../consumable-readiness/consumable-readiness.repository';
import {
  consumableRequirementNotFoundError,
} from '../consumable-readiness/consumable-readiness.errors';
import {
  hkBindingAlreadyExistsError,
  hkBindingBuildingMismatchError,
  hkBindingClientMismatchError,
  hkBindingItemNotConsumableError,
  hkBindingNotFoundError,
} from './inventory-hk-consumable-binding.errors';
import { inventoryHkConsumableBindingRepository } from './inventory-hk-consumable-binding.repository';
import type {
  CreateHkBindingInput,
  HkBindingFilters,
  HkReadiness,
  NewHkBinding,
  PublicHkConsumableBinding,
  UpdateHkBindingInput,
} from './inventory-hk-consumable-binding.types';

function computeReadiness(available: number | null, required: number, status: string): HkReadiness {
  if (status !== 'ACTIVE') return 'UNKNOWN';
  if (available === null || available <= 0) {
    return required > 0 ? 'NOT_READY' : 'READY';
  }
  if (available >= required) return 'READY';
  if (available > 0 && available < required) return 'LOW';
  return 'NOT_READY';
}

function toPublic(row: any): PublicHkConsumableBinding {
  const available = row.stockAvailable ?? null;
  const required = row.requiredQuantity ?? row.requirementRequiredQuantity ?? 1;
  const readiness = computeReadiness(available, required, row.status);

  const base: PublicHkConsumableBinding = {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    cleaningAreaId: row.cleaningAreaId ?? null,
    consumableRequirementId: row.consumableRequirementId,
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    requiredQuantity: typeof row.requiredQuantity === 'number' ? row.requiredQuantity : Number(row.requiredQuantity),
    status: row.status,
    notes: row.notes ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    cleaningArea: null,
    requirement: null,
    item: null,
    warehouse: null,
    currentStock: null,
    readiness,
  };

  if (row.cleaningAreaCode) {
    base.cleaningArea = {
      id: row.cleaningAreaId,
      code: row.cleaningAreaCode,
      name: row.cleaningAreaName,
    };
  }
  if (row.requirementCode) {
    base.requirement = {
      id: row.consumableRequirementId,
      code: row.requirementCode,
      name: row.requirementName,
      requiredQuantity: row.requirementRequiredQuantity !== null ? Number(row.requirementRequiredQuantity) : required,
      unit: row.requirementUnit,
      status: row.requirementStatus,
    };
  }
  if (row.itemCode) {
    base.item = {
      id: row.itemId,
      code: row.itemCode,
      name: row.itemName,
      itemType: row.itemType,
      uomId: row.itemUomId ?? null,
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
  if (row.stockAvailable !== undefined) {
    if (row.stockAvailable === null) {
      base.currentStock = null;
    } else {
      base.currentStock = {
        quantityOnHand: row.stockOnHand,
        reservedQuantity: row.stockReserved ?? 0,
        availableQuantity: row.stockAvailable,
      };
    }
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

export async function bindConsumable(
  input: CreateHkBindingInput,
  actorUserId?: string,
): Promise<PublicHkConsumableBinding> {
  // Resolve requirement via repository (has building_id, client_id, cleaning_area_id)
  const requirement = await consumableReadinessRepository.findRequirementById(input.consumableRequirementId);
  if (!requirement) {
    throw consumableRequirementNotFoundError();
  }

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) throw inventoryItemNotFoundError();

  if (item.itemType !== 'CONSUMABLE') {
    throw hkBindingItemNotConsumableError();
  }

  const warehouse = await inventoryWarehouseRepository.findById(input.warehouseId);
  if (!warehouse) throw inventoryWarehouseNotFoundError();

  // Cross-client checks
  // requirement has client_id via raw row? Requirement row from repository is RequirementWithContextRow which has client_id field lower? In earlier code, requirement object has building_id and client_id? Actually findRequirementById returns RequirementWithContextRow with client_id? Let's check: findRequirementById returned row with client_id? In service we used ctx.client_id. The repository's findRequirementById returns raw row? In consumable-readiness.repository, findRequirementById selects *? We need to assume it has client_id and building_id. Let's use building_id and client_id from requirement.
  const reqClientId = (requirement as any).client_id ?? (requirement as any).clientId;
  const reqBuildingId = (requirement as any).building_id ?? (requirement as any).buildingId;
  const reqCleaningAreaId = (requirement as any).cleaning_area_id ?? (requirement as any).cleaningAreaId ?? null;

  if (reqClientId !== item.clientId || reqClientId !== warehouse.clientId) {
    throw hkBindingClientMismatchError();
  }

  if (reqBuildingId !== warehouse.buildingId) {
    throw hkBindingBuildingMismatchError();
  }

  if (actorUserId) {
    await assertBuildingAccess(actorUserId, reqBuildingId);
  }

  const existing = await inventoryHkConsumableBindingRepository.findByRequirementWarehouseItem(
    input.consumableRequirementId,
    input.warehouseId,
    input.itemId,
  );
  if (existing) {
    throw hkBindingAlreadyExistsError();
  }

  const newRec: NewHkBinding = {
    clientId: reqClientId,
    buildingId: reqBuildingId,
    cleaningAreaId: reqCleaningAreaId,
    consumableRequirementId: input.consumableRequirementId,
    itemId: item.id,
    warehouseId: warehouse.id,
    requiredQuantity: input.requiredQuantity ?? Number((requirement as any).required_quantity ?? (requirement as any).requiredQuantity ?? 1),
    status: input.status ?? 'ACTIVE',
    notes: input.notes?.trim() || null,
  };

  try {
    const created = await inventoryHkConsumableBindingRepository.create(newRec);
    const detailed = await inventoryHkConsumableBindingRepository.findByIdWithDetails(created.id);
    return toPublic(detailed ?? created);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw hkBindingAlreadyExistsError();
    }
    throw e;
  }
}

export async function getBindingById(id: string, actorUserId?: string): Promise<PublicHkConsumableBinding> {
  const detailed = await inventoryHkConsumableBindingRepository.findByIdWithDetails(id);
  if (!detailed) throw hkBindingNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId);
  }
  return toPublic(detailed);
}

export async function listBindings(
  filters: HkBindingFilters,
  actorUserId?: string,
): Promise<PublicHkConsumableBinding[]> {
  if (filters.warehouseId) {
    const wh = await inventoryWarehouseRepository.findById(filters.warehouseId);
    if (!wh) throw inventoryWarehouseNotFoundError();
    if (filters.clientId && wh.clientId !== filters.clientId) throw hkBindingClientMismatchError();
    if (filters.buildingId && wh.buildingId !== filters.buildingId) throw hkBindingBuildingMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, wh.buildingId);
  } else if (filters.buildingId) {
    if (actorUserId) await assertBuildingAccess(actorUserId, filters.buildingId);
  } else if (filters.clientId && actorUserId) {
    await assertClientAccess(actorUserId, filters.clientId);
  }

  if (filters.itemId && filters.clientId) {
    const item = await inventoryItemRepository.findById(filters.itemId);
    if (!item) throw inventoryItemNotFoundError();
    if (item.clientId !== filters.clientId) throw hkBindingClientMismatchError();
  }

  if (filters.consumableRequirementId) {
    const req = await consumableReadinessRepository.findRequirementById(filters.consumableRequirementId);
    if (!req) throw consumableRequirementNotFoundError();
    const reqClientId = (req as any).client_id ?? (req as any).clientId;
    const reqBuildingId = (req as any).building_id ?? (req as any).buildingId;
    if (filters.clientId && reqClientId !== filters.clientId) throw hkBindingClientMismatchError();
    if (filters.buildingId && reqBuildingId !== filters.buildingId) throw hkBindingBuildingMismatchError();
    if (actorUserId) await assertBuildingAccess(actorUserId, reqBuildingId);
  }

  const rows = await inventoryHkConsumableBindingRepository.listWithDetails({
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    cleaningAreaId: filters.cleaningAreaId,
    consumableRequirementId: filters.consumableRequirementId,
    itemId: filters.itemId,
    warehouseId: filters.warehouseId,
    status: filters.status as any,
  });

  let filtered = rows.map(toPublic);

  if (filters.readiness) {
    filtered = filtered.filter(r => r.readiness === filters.readiness);
  }

  return filtered;
}

export async function updateBinding(
  id: string,
  input: { requiredQuantity?: number; status?: string; notes?: string | null },
  actorUserId?: string,
): Promise<PublicHkConsumableBinding> {
  const existing = await inventoryHkConsumableBindingRepository.findById(id);
  if (!existing) throw hkBindingNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, existing.buildingId);
  }

  const updated = await inventoryHkConsumableBindingRepository.update(id, input as any);
  if (!updated) throw hkBindingNotFoundError();

  const detailed = await inventoryHkConsumableBindingRepository.findByIdWithDetails(id);
  return toPublic(detailed ?? updated);
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'inventory_hk_consumable_bindings_unique';
}

export const inventoryHkConsumableBindingService = {
  bindConsumable,
  getBindingById,
  listBindings,
  updateBinding,
};

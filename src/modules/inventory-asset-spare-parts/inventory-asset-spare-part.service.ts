import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { assetRepository } from '../assets';
import { inventoryItemRepository } from '../inventory-items';
import { assetNotFoundError } from '../assets/asset.errors';
import { inventoryItemNotFoundError } from '../inventory-items/inventory-item.errors';
import {
  assetSparePartAlreadyExistsError,
  assetSparePartClientMismatchError,
  assetSparePartItemNotSparePartError,
  assetSparePartNotFoundError,
} from './inventory-asset-spare-part.errors';
import { inventoryAssetSparePartRepository } from './inventory-asset-spare-part.repository';
import type {
  CreateAssetSparePartInput,
  AssetSparePartFilters,
  NewAssetSparePart,
  PublicAssetSparePart,
  UpdateAssetSparePartInput,
} from './inventory-asset-spare-part.types';

function toPublic(row: any): PublicAssetSparePart {
  const base: PublicAssetSparePart = {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    assetId: row.assetId,
    itemId: row.itemId,
    requiredQuantity: typeof row.requiredQuantity === 'number' ? row.requiredQuantity : Number(row.requiredQuantity),
    status: row.status,
    notes: row.notes ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    asset: null,
    item: null,
  };

  if (row.assetCode) {
    base.asset = {
      id: row.assetId,
      assetCode: row.assetCode,
      assetName: row.assetName,
      buildingId: row.assetBuildingId ?? row.buildingId,
      status: row.assetStatus ?? 'ACTIVE',
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

export async function bindSparePartToAsset(
  input: CreateAssetSparePartInput,
  actorUserId?: string,
): Promise<PublicAssetSparePart> {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) throw assetNotFoundError();

  const item = await inventoryItemRepository.findById(input.itemId);
  if (!item) throw inventoryItemNotFoundError();

  if (asset.clientId !== item.clientId) {
    throw assetSparePartClientMismatchError();
  }

  if (item.itemType !== 'SPARE_PART') {
    throw assetSparePartItemNotSparePartError();
  }

  if (actorUserId) {
    await assertBuildingAccess(actorUserId, asset.buildingId);
  }

  const existing = await inventoryAssetSparePartRepository.findByAssetAndItem(
    input.assetId,
    input.itemId,
  );
  if (existing) {
    throw assetSparePartAlreadyExistsError();
  }

  const newRec: NewAssetSparePart = {
    clientId: asset.clientId,
    buildingId: asset.buildingId,
    assetId: asset.id,
    itemId: item.id,
    requiredQuantity: input.requiredQuantity ?? 1,
    status: input.status ?? 'ACTIVE',
    notes: input.notes?.trim() || null,
  };

  try {
    const created = await inventoryAssetSparePartRepository.create(newRec);
    const detailed = await inventoryAssetSparePartRepository.findByIdWithDetails(created.id);
    return toPublic(detailed ?? created);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw assetSparePartAlreadyExistsError();
    }
    throw e;
  }
}

export async function getBindingById(id: string, actorUserId?: string): Promise<PublicAssetSparePart> {
  const detailed = await inventoryAssetSparePartRepository.findByIdWithDetails(id);
  if (!detailed) throw assetSparePartNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, detailed.buildingId);
  }
  return toPublic(detailed);
}

export async function listSparePartsByAsset(
  assetId: string,
  filters: Omit<AssetSparePartFilters, 'assetId'>,
  actorUserId?: string,
): Promise<PublicAssetSparePart[]> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) throw assetNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, asset.buildingId);
  }
  if (filters.clientId && filters.clientId !== asset.clientId) {
    throw assetSparePartClientMismatchError();
  }
  if (filters.buildingId && filters.buildingId !== asset.buildingId) {
    throw assetSparePartClientMismatchError();
  }

  const rows = await inventoryAssetSparePartRepository.listWithDetails({
    assetId,
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    itemId: filters.itemId,
    status: filters.status as any,
  });

  return rows.map(toPublic);
}

export async function listAssetsBySparePart(
  itemId: string,
  filters: Omit<AssetSparePartFilters, 'itemId'>,
  actorUserId?: string,
): Promise<PublicAssetSparePart[]> {
  const item = await inventoryItemRepository.findById(itemId);
  if (!item) throw inventoryItemNotFoundError();

  if (filters.clientId && filters.clientId !== item.clientId) {
    throw assetSparePartClientMismatchError();
  }

  // If building filter provided, need to check actor access for that building
  if (filters.buildingId && actorUserId) {
    await assertBuildingAccess(actorUserId, filters.buildingId);
  } else if (filters.clientId && actorUserId) {
    await assertClientAccess(actorUserId, filters.clientId);
  } else if (actorUserId && !filters.buildingId && !filters.clientId && !filters.assetId) {
    // No building/client filter and actor provided: allow but will filter via building access later?
    // For simplicity, check client access for item's client
    await assertClientAccess(actorUserId, item.clientId);
  }

  // Additional: if actor provided and asset filter provided, check asset building access
  if (filters.assetId && actorUserId) {
    const asset = await assetRepository.findById(filters.assetId);
    if (!asset) throw assetNotFoundError();
    await assertBuildingAccess(actorUserId, asset.buildingId);
  }

  const rows = await inventoryAssetSparePartRepository.listWithDetails({
    itemId,
    clientId: filters.clientId,
    buildingId: filters.buildingId,
    assetId: filters.assetId,
    status: filters.status as any,
  });

  // For client isolation when actor has limited building access but no building filter, we should filter out inaccessible buildings
  // For simplicity, if actorUserId provided and no building/client filter, we already checked client access, but we should still filter by accessible buildings
  if (actorUserId && !filters.buildingId && !filters.clientId) {
    const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
    return rows
      .filter(r => accessibleBuildingIds.includes(r.buildingId))
      .map(toPublic);
  }

  return rows.map(toPublic);
}

export async function updateBinding(
  id: string,
  input: UpdateAssetSparePartInput,
  actorUserId?: string,
): Promise<PublicAssetSparePart> {
  const existing = await inventoryAssetSparePartRepository.findById(id);
  if (!existing) throw assetSparePartNotFoundError();
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, existing.buildingId);
  }

  const updated = await inventoryAssetSparePartRepository.update(id, {
    requiredQuantity: input.requiredQuantity,
    status: input.status,
    notes: input.notes,
  });

  if (!updated) throw assetSparePartNotFoundError();
  const detailed = await inventoryAssetSparePartRepository.findByIdWithDetails(id);
  return toPublic(detailed ?? updated);
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'inventory_asset_spare_parts_asset_item_unique';
}

export const inventoryAssetSparePartService = {
  bindSparePartToAsset,
  getBindingById,
  listSparePartsByAsset,
  listAssetsBySparePart,
  updateBinding,
};

import { getPool } from '../../database';
import { clientInactiveError, clientNotFoundError, clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import {
  inventoryItemCodeAlreadyExistsError,
  inventoryItemNotFoundError,
  inventoryItemUomClientMismatchError,
  inventoryItemUomInactiveError,
  inventoryItemUomNotFoundError,
} from './inventory-item.errors';
import { inventoryItemRepository } from './inventory-item.repository';
import type {
  CreateInventoryItemInput,
  InventoryItemFilters,
  InventoryItemRecord,
  NewInventoryItem,
  PublicInventoryItem,
  UpdateInventoryItemInput,
  UpdateInventoryItemStatusInput,
} from './inventory-item.types';

function toPublic(
  record: InventoryItemRecord & {
    uomCode?: string;
    uomName?: string;
    uomSymbol?: string;
  },
): PublicInventoryItem {
  const base: PublicInventoryItem = {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    itemType: record.itemType,
    category: record.category,
    uomId: record.uomId,
    description: record.description,
    status: record.status,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : String(record.createdAt),
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : String(record.updatedAt),
    uom: null,
  };

  if (record.uomId && (record as any).uomCode) {
    base.uom = {
      id: record.uomId,
      code: (record as any).uomCode,
      name: (record as any).uomName,
      symbol: (record as any).uomSymbol,
    };
  }

  return base;
}

function toPublicSimple(record: InventoryItemRecord): PublicInventoryItem {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    itemType: record.itemType,
    category: record.category,
    uomId: record.uomId,
    description: record.description,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    uom: null,
  };
}

async function assertUom(
  uomId: string,
  clientId: string,
): Promise<void> {
  const result = await getPool().query(
    'SELECT id, client_id, status FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  const row = result.rows[0];
  if (!row) {
    throw inventoryItemUomNotFoundError();
  }
  if (row.client_id !== clientId) {
    throw inventoryItemUomClientMismatchError();
  }
  if (row.status !== 'ACTIVE') {
    throw inventoryItemUomInactiveError();
  }
}

async function resolveClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  // If actor is provided, enforce client isolation via building access.
  // A user can access a client when they have at least one active building under that client.
  if (!actorUserId) {
    return;
  }
  const canAccess = await contextAccessService.canAccessClient(actorUserId, clientId);
  if (!canAccess) {
    // Reuse client not found to avoid leaking existence — but we already checked existence.
    // For isolation we throw building access denied pattern; however to keep contract we
    // throw client not found if no buildings, but for explicit isolation we can throw BUILDING_ACCESS_DENIED?
    // We keep generic: if no access, treat as building denied — reuse client not found is okay?
    // To be strict for inventory, we enforce via assert logic: we already expose client-scoped list
    // only to users who have access. If not, list will be empty? Instead for create/get we deny.
    // We'll leverage the same error used elsewhere: building access denied is 403, but client isolation
    // for item master should be 403 as well. For minimal, we allow create/get but still validated via
    // canAccessClient — if false, we throw buildingAccessDenied error via context-access.
    // Importing that error lazily to avoid circular.
    const { buildingAccessDeniedError } = await import('../context-access/context-access.errors');
    throw buildingAccessDeniedError();
  }
}

/**
 * Creates an Inventory Item under a Client.
 * Validation order:
 * 1. unknown Client → 404 CLIENT_NOT_FOUND
 * 2. INACTIVE Client → 400 CLIENT_INACTIVE
 * 3. duplicate code for Client → 409 INVENTORY_ITEM_CODE_ALREADY_EXISTS
 * 4. unknown UOM → 404 INVENTORY_ITEM_UOM_NOT_FOUND
 * 5. UOM of different Client → 400 UOM_CLIENT_MISMATCH
 * 6. INACTIVE UOM → 400 UOM_INACTIVE
 */
export async function createInventoryItem(
  input: CreateInventoryItemInput,
  actorUserId?: string,
): Promise<PublicInventoryItem> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  if (actorUserId) {
    await resolveClientAccess(actorUserId, input.clientId);
  }

  const existing = await inventoryItemRepository.findByCodeForClient(input.clientId, input.code);
  if (existing) {
    throw inventoryItemCodeAlreadyExistsError();
  }

  if (input.uomId) {
    await assertUom(input.uomId, input.clientId);
  }

  const newItem: NewInventoryItem = {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    itemType: input.itemType,
    category: input.category?.trim() ? input.category.trim().toUpperCase() : null,
    uomId: input.uomId ?? null,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await inventoryItemRepository.createItem(newItem);
    const withUom = await inventoryItemRepository.findByIdWithUom(record.id);
    return withUom ? toPublic(withUom as any) : toPublicSimple(record);
  } catch (error) {
    if (isCodeUniqueViolation(error)) {
      throw inventoryItemCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getInventoryItemById(
  id: string,
  actorUserId?: string,
): Promise<PublicInventoryItem> {
  const withUom = await inventoryItemRepository.findByIdWithUom(id);
  if (!withUom) {
    throw inventoryItemNotFoundError();
  }
  if (actorUserId) {
    await resolveClientAccess(actorUserId, (withUom as any).clientId);
  }
  return toPublic(withUom as any);
}

export async function listInventoryItems(
  filter: InventoryItemFilters,
  actorUserId?: string,
): Promise<PublicInventoryItem[]> {
  const client = await clientRepository.findById(filter.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (actorUserId) {
    await resolveClientAccess(actorUserId, filter.clientId);
  }

  const records = await inventoryItemRepository.listByClient(filter.clientId, {
    status: filter.status,
    itemType: filter.itemType,
    category: filter.category,
    search: filter.search,
    uomId: filter.uomId,
  });

  // Batch fetch UOMs for enrichment without N+1
  const uomIds = [...new Set(records.map((r) => r.uomId).filter((v): v is string => Boolean(v)))];
  let uomMap = new Map<string, { code: string; name: string; symbol: string }>();
  if (uomIds.length) {
    const result = await getPool().query(
      `SELECT id, code, name, symbol FROM units_of_measure WHERE id = ANY($1)`,
      [uomIds],
    );
    for (const row of result.rows) {
      uomMap.set(row.id, { code: row.code, name: row.name, symbol: row.symbol });
    }
  }

  return records.map((r) => {
    const base = toPublicSimple(r);
    if (r.uomId && uomMap.has(r.uomId)) {
      const u = uomMap.get(r.uomId)!;
      base.uom = { id: r.uomId, code: u.code, name: u.name, symbol: u.symbol };
    }
    return base;
  });
}

export async function updateInventoryItem(
  id: string,
  input: UpdateInventoryItemInput,
  actorUserId?: string,
): Promise<PublicInventoryItem> {
  const existing = await inventoryItemRepository.findById(id);
  if (!existing) {
    throw inventoryItemNotFoundError();
  }

  if (actorUserId) {
    await resolveClientAccess(actorUserId, existing.clientId);
  }

  if (input.uomId !== undefined && input.uomId !== null) {
    await assertUom(input.uomId, existing.clientId);
  }

  const updated = await inventoryItemRepository.updateItem(id, {
    name: input.name?.trim(),
    itemType: input.itemType,
    category:
      input.category === undefined
        ? undefined
        : input.category === null
          ? null
          : input.category.trim().toUpperCase(),
    uomId: input.uomId,
    description:
      input.description === undefined
        ? undefined
        : input.description === null
          ? null
          : input.description.trim() || null,
    status: input.status,
  });

  if (!updated) {
    throw inventoryItemNotFoundError();
  }

  const withUom = await inventoryItemRepository.findByIdWithUom(id);
  return withUom ? toPublic(withUom as any) : toPublicSimple(updated);
}

export async function updateInventoryItemStatus(
  id: string,
  input: UpdateInventoryItemStatusInput,
  actorUserId?: string,
): Promise<PublicInventoryItem> {
  return updateInventoryItem(id, { status: input.status }, actorUserId);
}

function isCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === 'inventory_items_client_code_unique';
}

export const inventoryItemService = {
  createInventoryItem,
  getInventoryItemById,
  listInventoryItems,
  updateInventoryItem,
  updateInventoryItemStatus,
};

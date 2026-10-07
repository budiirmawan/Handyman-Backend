/**
 * BE-16A — Inventory Item Master domain types.
 *
 * Shared inventory catalog owned by exactly one Client.
 * Code is unique per Client (client_id + code), same as asset/vendor pattern.
 * Item type is DATA (SPARE_PART, MATERIAL, CONSUMABLE) — no behavior branching here.
 * UOM reuses BE-07 units_of_measure foundation: optional FK, enforced same client + ACTIVE.
 * Status: ACTIVE / INACTIVE — inactive preserved for history.
 * No stock, movement, procurement, PO, pricing, accounting in BE-16A.
 */

export const INVENTORY_ITEM_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type InventoryItemStatus = (typeof INVENTORY_ITEM_STATUSES)[number];

export function isInventoryItemStatus(value: unknown): value is InventoryItemStatus {
  return (
    typeof value === 'string' &&
    (INVENTORY_ITEM_STATUSES as readonly string[]).includes(value)
  );
}

export const INVENTORY_ITEM_TYPES = ['SPARE_PART', 'MATERIAL', 'CONSUMABLE'] as const;
export type InventoryItemType = (typeof INVENTORY_ITEM_TYPES)[number];

export function isInventoryItemType(value: unknown): value is InventoryItemType {
  return (
    typeof value === 'string' &&
    (INVENTORY_ITEM_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type InventoryItemRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  itemType: InventoryItemType;
  category: string | null;
  uomId: string | null;
  description: string | null;
  status: InventoryItemStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicInventoryItem = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  itemType: InventoryItemType;
  category: string | null;
  uomId: string | null;
  description: string | null;
  status: InventoryItemStatus;
  createdAt: string;
  updatedAt: string;
  /** Optional resolved UOM context when available. */
  uom?: {
    id: string;
    code: string;
    name: string;
    symbol: string;
  } | null;
};

/** Input supplied by API consumer when creating an Item. */
export type CreateInventoryItemInput = {
  clientId: string;
  code: string;
  name: string;
  itemType: InventoryItemType;
  category?: string;
  uomId?: string | null;
  description?: string;
  status?: InventoryItemStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewInventoryItem = {
  clientId: string;
  code: string;
  name: string;
  itemType: InventoryItemType;
  category: string | null;
  uomId: string | null;
  description: string | null;
  status: InventoryItemStatus;
};

/** Partial update input (PATCH /inventory-items/:id). */
export type UpdateInventoryItemInput = {
  name?: string;
  itemType?: InventoryItemType;
  category?: string | null;
  uomId?: string | null;
  description?: string | null;
  status?: InventoryItemStatus;
};

/** Status-only update input. */
export type UpdateInventoryItemStatusInput = {
  status: InventoryItemStatus;
};

/** List filters for GET /clients/:clientId/inventory-items */
export type InventoryItemFilters = {
  clientId: string;
  status?: InventoryItemStatus;
  itemType?: InventoryItemType;
  category?: string;
  search?: string;
  uomId?: string;
};

/**
 * BE-16B — Warehouse / Store domain types.
 *
 * A Warehouse/Store is a physical storage location owned by exactly one Client
 * and operated within exactly one Building (Client → Property → Building → Warehouse).
 * Client_id is derived via Building → Property → Client, never from caller.
 * Code unique per Building (building_id + code), matching cleaning_area precedent.
 * Optional location binding: functional_location_id → BE-04G functional_locations,
 * validated same Building, ACTIVE check.
 * Status ACTIVE/INACTIVE, preserved for history.
 * No stock balance/movement here — BE-16C onward.
 */

export const INVENTORY_WAREHOUSE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type InventoryWarehouseStatus = (typeof INVENTORY_WAREHOUSE_STATUSES)[number];

export function isInventoryWarehouseStatus(
  value: unknown,
): value is InventoryWarehouseStatus {
  return (
    typeof value === 'string' &&
    (INVENTORY_WAREHOUSE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full DB record. */
export type InventoryWarehouseRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: InventoryWarehouseStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Public API shape. */
export type PublicInventoryWarehouse = {
  id: string;
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: InventoryWarehouseStatus;
  createdAt: string;
  updatedAt: string;
  functionalLocation?: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
};

/** Input when creating via POST /buildings/:buildingId/warehouses */
export type CreateInventoryWarehouseInput = {
  buildingId: string;
  code: string;
  name: string;
  functionalLocationId?: string | null;
  description?: string;
  status?: InventoryWarehouseStatus;
};

/** Fully resolved for persistence. */
export type NewInventoryWarehouse = {
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: InventoryWarehouseStatus;
};

/** PATCH body */
export type UpdateInventoryWarehouseInput = {
  name?: string;
  functionalLocationId?: string | null;
  description?: string | null;
  status?: InventoryWarehouseStatus;
};

export type UpdateInventoryWarehouseStatusInput = {
  status: InventoryWarehouseStatus;
};

export type InventoryWarehouseFilters = {
  buildingId?: string;
  clientId?: string;
  status?: InventoryWarehouseStatus;
  search?: string;
  functionalLocationId?: string;
};

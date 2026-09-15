/**
 * BE-16J — Housekeeping Consumable Binding types.
 * Binds BE-11J consumable_requirements to BE-16A CONSUMABLE items + warehouse for authoritative stock.
 * Readiness derived from stock: READY / LOW / NOT_READY / UNKNOWN
 */

export const HK_BINDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type HkBindingStatus = (typeof HK_BINDING_STATUSES)[number];

export function isHkBindingStatus(v: unknown): v is HkBindingStatus {
  return typeof v === 'string' && (HK_BINDING_STATUSES as readonly string[]).includes(v);
}

export const HK_READINESS = ['READY', 'LOW', 'NOT_READY', 'UNKNOWN'] as const;
export type HkReadiness = (typeof HK_READINESS)[number];

export type HkConsumableBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  consumableRequirementId: string;
  itemId: string;
  warehouseId: string;
  requiredQuantity: number;
  status: HkBindingStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHkConsumableBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  consumableRequirementId: string;
  itemId: string;
  warehouseId: string;
  requiredQuantity: number;
  status: HkBindingStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: { id: string; code: string; name: string } | null;
  requirement?: { id: string; code: string; name: string; requiredQuantity: number; unit: string; status: string } | null;
  item?: { id: string; code: string; name: string; itemType: string; uomId: string | null } | null;
  warehouse?: { id: string; code: string; name: string; buildingId: string } | null;
  currentStock?: { quantityOnHand: number; reservedQuantity: number; availableQuantity: number } | null;
  readiness: HkReadiness;
};

export type CreateHkBindingInput = {
  consumableRequirementId: string;
  itemId: string;
  warehouseId: string;
  requiredQuantity?: number;
  status?: HkBindingStatus;
  notes?: string;
};

export type NewHkBinding = {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  consumableRequirementId: string;
  itemId: string;
  warehouseId: string;
  requiredQuantity: number;
  status: HkBindingStatus;
  notes: string | null;
};

export type UpdateHkBindingInput = {
  requiredQuantity?: number;
  status?: HkBindingStatus;
  notes?: string | null;
};

export type HkBindingFilters = {
  clientId?: string;
  buildingId?: string;
  cleaningAreaId?: string;
  consumableRequirementId?: string;
  itemId?: string;
  warehouseId?: string;
  status?: HkBindingStatus;
  readiness?: HkReadiness;
};

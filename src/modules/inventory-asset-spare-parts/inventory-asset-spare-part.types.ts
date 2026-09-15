/**
 * BE-16H — Asset Spare Part Binding types.
 * Many-to-many Asset ↔ SPARE_PART Item.
 */

export const ASSET_SPARE_PART_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type AssetSparePartStatus = (typeof ASSET_SPARE_PART_STATUSES)[number];

export function isAssetSparePartStatus(v: unknown): v is AssetSparePartStatus {
  return typeof v === 'string' && (ASSET_SPARE_PART_STATUSES as readonly string[]).includes(v);
}

export type AssetSparePartRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  itemId: string;
  requiredQuantity: number;
  status: AssetSparePartStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicAssetSparePart = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  itemId: string;
  requiredQuantity: number;
  status: AssetSparePartStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  asset?: { id: string; assetCode: string; assetName: string; buildingId: string; status: string } | null;
  item?: { id: string; code: string; name: string; itemType: string; uomId: string | null } | null;
};

export type CreateAssetSparePartInput = {
  assetId: string;
  itemId: string;
  requiredQuantity?: number;
  status?: AssetSparePartStatus;
  notes?: string;
};

export type NewAssetSparePart = {
  clientId: string;
  buildingId: string;
  assetId: string;
  itemId: string;
  requiredQuantity: number;
  status: AssetSparePartStatus;
  notes: string | null;
};

export type UpdateAssetSparePartInput = {
  requiredQuantity?: number;
  status?: AssetSparePartStatus;
  notes?: string | null;
};

export type AssetSparePartFilters = {
  clientId?: string;
  buildingId?: string;
  assetId?: string;
  itemId?: string;
  status?: AssetSparePartStatus;
};

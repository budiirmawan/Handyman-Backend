/**
 * BE-05B — Asset Type / Class domain types.
 *
 * An Asset Type is the finer classification level beneath an Asset Category
 * (e.g. HVAC → AHU, CHILLER, FCU; ELECTRICAL → PANEL, GENSET). It always
 * belongs to exactly one Category, and Client ownership is derived
 * authoritatively through Asset Type → Asset Category → Client — the Type
 * carries NO `clientId` of its own.
 *
 * Type codes are DATA, not behavior: no application logic branches on a
 * specific type code.
 */
export const ASSET_TYPE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type AssetTypeStatus = (typeof ASSET_TYPE_STATUSES)[number];

export function isAssetTypeStatus(value: unknown): value is AssetTypeStatus {
  return (
    typeof value === 'string' &&
    (ASSET_TYPE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AssetTypeRecord = {
  id: string;
  assetCategoryId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetTypeStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicAssetType = {
  id: string;
  assetCategoryId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetTypeStatus;
};

/** Input supplied by the API consumer when creating an Asset Type. */
export type CreateAssetTypeInput = {
  assetCategoryId: string;
  code: string;
  name: string;
  description?: string;
  status?: AssetTypeStatus;
};

/** Fully-resolved asset type data ready for persistence. */
export type NewAssetType = {
  assetCategoryId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetTypeStatus;
};

/** Partial update input (PATCH /asset-types/:id). */
export type UpdateAssetTypeInput = {
  name?: string;
  description?: string;
  status?: AssetTypeStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateAssetTypeStatusInput = {
  status: AssetTypeStatus;
};

/**
 * BE-05B — Asset Category domain types.
 *
 * An Asset Category is Client-scoped classification/reference data for Assets
 * (e.g. ELECTRICAL, MECHANICAL, HVAC, FIRE_PROTECTION, LIFT, PLUMBING,
 * SECURITY_SYSTEM). It is NOT an Asset and NOT a hierarchy level — the
 * registry chain remains Client → Property → Building → Asset, and a Category
 * merely classifies an Asset via the optional `assets.asset_category_id`.
 *
 * Category codes are DATA, not behavior: no application logic branches on a
 * specific category code.
 */
export const ASSET_CATEGORY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type AssetCategoryStatus = (typeof ASSET_CATEGORY_STATUSES)[number];

export function isAssetCategoryStatus(
  value: unknown,
): value is AssetCategoryStatus {
  return (
    typeof value === 'string' &&
    (ASSET_CATEGORY_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AssetCategoryRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetCategoryStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicAssetCategory = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetCategoryStatus;
};

/** Input supplied by the API consumer when creating an Asset Category. */
export type CreateAssetCategoryInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  status?: AssetCategoryStatus;
};

/** Fully-resolved category data ready for persistence. */
export type NewAssetCategory = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetCategoryStatus;
};

/** Partial update input (PATCH /asset-categories/:id). */
export type UpdateAssetCategoryInput = {
  name?: string;
  description?: string;
  status?: AssetCategoryStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateAssetCategoryStatusInput = {
  status: AssetCategoryStatus;
};

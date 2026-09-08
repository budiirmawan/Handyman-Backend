/**
 * BE-05F — Asset Warranty domain types.
 *
 * A Warranty is COMMERCIAL / SERVICE COVERAGE attached to exactly one Asset.
 * An Asset accumulates many warranty records over its life (renewals,
 * extensions, superseded coverage), so this is history — unlike the BE-05D
 * Equipment Profile, which is a singleton.
 *
 * Client / Building ownership is derived through
 * Warranty → Asset → Building → Property → Client and never duplicated.
 *
 * A Warranty is NOT a vendor contract, a claim, a maintenance record, a
 * certification, a QR identifier, or an Asset History entry.
 */
export const ASSET_WARRANTY_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'INACTIVE',
] as const;

export type AssetWarrantyStatus = (typeof ASSET_WARRANTY_STATUSES)[number];

export function isAssetWarrantyStatus(
  value: unknown,
): value is AssetWarrantyStatus {
  return (
    typeof value === 'string' &&
    (ASSET_WARRANTY_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AssetWarrantyRecord = {
  id: string;
  assetId: string;
  providerName: string;
  warrantyNumber: string;
  startDate: Date;
  endDate: Date;
  coverageDescription: string | null;
  status: AssetWarrantyStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation. Dates are `YYYY-MM-DD` calendar dates — a
 * warranty runs for days, not instants.
 *
 * `isCurrentlyCovered` is the backend's authoritative answer to "is this
 * asset under warranty today?", derived from status AND the date window, so
 * clients never recompute coverage locally.
 */
export type PublicAssetWarranty = {
  id: string;
  assetId: string;
  providerName: string;
  warrantyNumber: string;
  startDate: string;
  endDate: string;
  coverageDescription: string | null;
  status: AssetWarrantyStatus;
  isCurrentlyCovered: boolean;
};

/** Input supplied by the API consumer when registering coverage. */
export type CreateAssetWarrantyInput = {
  assetId: string;
  providerName: string;
  warrantyNumber: string;
  startDate: string;
  endDate: string;
  coverageDescription?: string;
  status?: AssetWarrantyStatus;
};

/** Fully-resolved warranty data ready for persistence. */
export type NewAssetWarranty = {
  assetId: string;
  providerName: string;
  warrantyNumber: string;
  startDate: string;
  endDate: string;
  coverageDescription: string | null;
  status: AssetWarrantyStatus;
};

/**
 * Partial update input (PATCH /assets/:assetId/warranties/:warrantyId).
 *
 * `assetId` is immutable: coverage never migrates between Assets (that would
 * silently re-home its derived Client ownership).
 */
export type UpdateAssetWarrantyInput = {
  providerName?: string;
  warrantyNumber?: string;
  startDate?: string;
  endDate?: string;
  coverageDescription?: string | null;
  status?: AssetWarrantyStatus;
};

/** Status-only update input (service-level coverage-state operation). */
export type UpdateAssetWarrantyStatusInput = {
  status: AssetWarrantyStatus;
};

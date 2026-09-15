/**
 * BE-05H — Asset Identifier domain types.
 *
 * An Identifier is the FIELD-FACING handle for exactly one Asset: the value
 * printed on a QR label, an asset tag, a barcode, or carried over from a
 * legacy register.
 *
 * Values are OPAQUE by design — no Client, Building, or security data is
 * encoded in them, so a label read by anyone leaks nothing.
 *
 * Client / Building ownership is derived through
 * Identifier → Asset → Building → Property → Client and never duplicated.
 *
 * An Identifier is NOT a QR image, a scanner, an Asset History entry, a Work
 * Order, a PM plan, or a checklist.
 */
export const ASSET_IDENTIFIER_TYPES = [
  'QR',
  'TAG',
  'BARCODE',
  'LEGACY',
] as const;

export type AssetIdentifierType = (typeof ASSET_IDENTIFIER_TYPES)[number];

export function isAssetIdentifierType(
  value: unknown,
): value is AssetIdentifierType {
  return (
    typeof value === 'string' &&
    (ASSET_IDENTIFIER_TYPES as readonly string[]).includes(value)
  );
}

export const ASSET_IDENTIFIER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type AssetIdentifierStatus =
  (typeof ASSET_IDENTIFIER_STATUSES)[number];

export function isAssetIdentifierStatus(
  value: unknown,
): value is AssetIdentifierStatus {
  return (
    typeof value === 'string' &&
    (ASSET_IDENTIFIER_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AssetIdentifierRecord = {
  id: string;
  assetId: string;
  identifierType: AssetIdentifierType;
  identifierValue: string;
  status: AssetIdentifierStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicAssetIdentifier = {
  id: string;
  assetId: string;
  identifierType: AssetIdentifierType;
  identifierValue: string;
  status: AssetIdentifierStatus;
};

/**
 * Input supplied when registering an identifier.
 *
 * `identifierValue` is OPTIONAL: when omitted the backend mints an opaque
 * value itself, which is the preferred path for QR labels — the caller never
 * has to invent one, and a generated value cannot accidentally embed
 * meaningful data.
 */
export type CreateAssetIdentifierInput = {
  assetId: string;
  identifierType: AssetIdentifierType;
  identifierValue?: string;
  status?: AssetIdentifierStatus;
};

/** Fully-resolved identifier data ready for persistence. */
export type NewAssetIdentifier = {
  assetId: string;
  identifierType: AssetIdentifierType;
  identifierValue: string;
  status: AssetIdentifierStatus;
};

/**
 * Partial update input.
 *
 * `assetId` and `identifierValue` are immutable: a printed label cannot be
 * silently re-pointed at another Asset, nor its value rewritten while the
 * physical sticker in the field still shows the old one. Retire the
 * identifier (status INACTIVE) and issue a new one instead.
 */
export type UpdateAssetIdentifierInput = {
  status?: AssetIdentifierStatus;
};

/** Status-only update input (retire / reinstate a label). */
export type UpdateAssetIdentifierStatusInput = {
  status: AssetIdentifierStatus;
};

/**
 * The SAFE, MINIMAL Asset context returned by identifier resolution.
 *
 * Deliberately narrow: enough to identify the equipment in the field, and
 * nothing more. No credentials, no security data, no commercial or
 * contractual information, and no unrelated Client data — `clientId` is
 * omitted entirely; the Building is the operational scope a field user
 * already works within.
 */
export type ResolvedAssetIdentifier = {
  identifier: {
    id: string;
    identifierType: AssetIdentifierType;
    identifierValue: string;
  };
  asset: {
    id: string;
    buildingId: string;
    assetCode: string;
    assetName: string;
    status: string;
    functionalLocationId: string | null;
  };
};

/**
 * BE-05G — Asset Certification domain types.
 *
 * A Certification is STATUTORY / TECHNICAL / INSPECTION / COMPLIANCE
 * certification attached to exactly one Asset. An Asset accumulates many
 * certification records over its life, and may hold several DIFFERENT types
 * concurrently — so this is history, controlled per type.
 *
 * Client / Building ownership is derived through
 * Certification → Asset → Building → Property → Client and never duplicated.
 *
 * A Certification is NOT an inspection execution, a renewal workflow, a
 * document repository entry, a QR identifier, or an Asset History entry.
 */
export const ASSET_CERTIFICATION_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'INACTIVE',
] as const;

export type AssetCertificationStatus =
  (typeof ASSET_CERTIFICATION_STATUSES)[number];

export function isAssetCertificationStatus(
  value: unknown,
): value is AssetCertificationStatus {
  return (
    typeof value === 'string' &&
    (ASSET_CERTIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AssetCertificationRecord = {
  id: string;
  assetId: string;
  certificationType: string;
  certificateNumber: string;
  issuingAuthority: string;
  issueDate: Date;
  /** NULL = perpetual certification with no renewal date. */
  expiryDate: Date | null;
  status: AssetCertificationStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation. Dates are `YYYY-MM-DD` calendar dates.
 *
 * `isCurrentlyEffective` is the backend's authoritative answer to "is this
 * certification in force today?", derived from status AND the validity
 * window, so clients never recompute compliance locally.
 */
export type PublicAssetCertification = {
  id: string;
  assetId: string;
  certificationType: string;
  certificateNumber: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate: string | null;
  status: AssetCertificationStatus;
  notes: string | null;
  isCurrentlyEffective: boolean;
};

/** Input supplied by the API consumer when registering a certification. */
export type CreateAssetCertificationInput = {
  assetId: string;
  certificationType: string;
  certificateNumber: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate?: string;
  status?: AssetCertificationStatus;
  notes?: string;
};

/** Fully-resolved certification data ready for persistence. */
export type NewAssetCertification = {
  assetId: string;
  certificationType: string;
  certificateNumber: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate: string | null;
  status: AssetCertificationStatus;
  notes: string | null;
};

/**
 * Partial update input
 * (PATCH /assets/:assetId/certifications/:certificationId).
 *
 * `assetId` is immutable: a certificate never migrates between Assets (that
 * would silently re-home its derived Client ownership). `expiryDate` accepts
 * an explicit null to mark the certification perpetual.
 */
export type UpdateAssetCertificationInput = {
  certificationType?: string;
  certificateNumber?: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiryDate?: string | null;
  status?: AssetCertificationStatus;
  notes?: string | null;
};

/** Status-only update input (service-level certification-state operation). */
export type UpdateAssetCertificationStatusInput = {
  status: AssetCertificationStatus;
};

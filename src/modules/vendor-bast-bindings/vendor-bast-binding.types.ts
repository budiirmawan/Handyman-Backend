/**
 * BE-15H compatibility types.
 *
 * `vendor_bast_bindings` preserves the legacy Vendor Work-facing shape, but a
 * context-consistent `bast_documents` link is the sole lifecycle authority.
 * Legacy-only rows remain readable as explicitly labelled compatibility
 * fallbacks and cannot be mutated through the legacy API.
 */
export const BAST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'ACCEPTED',
  'REJECTED',
] as const;

export type BastStatus = (typeof BAST_STATUSES)[number];

export function isBastStatus(value: unknown): value is BastStatus {
  return (
    typeof value === 'string' &&
    (BAST_STATUSES as readonly string[]).includes(value)
  );
}

/** Retained for clients that still validate the historical state vocabulary. */
export const BAST_TRANSITIONS: Record<BastStatus, readonly BastStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [],
  REJECTED: ['SUBMITTED'],
};

export function canTransitionBastStatus(
  from: BastStatus,
  to: BastStatus,
): boolean {
  return (BAST_TRANSITIONS[from] as readonly BastStatus[]).includes(to);
}

export type VendorBastLifecycleAuthority =
  | 'CANONICAL_BAST'
  | 'LEGACY_ONLY_FALLBACK'
  | 'UNRESOLVED_CANONICAL_LINK';

export type VendorBastCompatibility = {
  lifecycleAuthority: VendorBastLifecycleAuthority;
  reconciliationRequired: boolean;
  /** Historical stored value; never the authority when lifecycleAuthority is CANONICAL_BAST. */
  legacyAcceptanceStatus: BastStatus;
};

export type VendorBastAcceptanceSignOffRecord = {
  id: string;
  bastSubmissionAttemptId: string;
  documentVersionId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  signerUserId: string;
  notes: string | null;
  signedAt: Date;
};

export type PublicVendorBastAcceptanceSignOff = Omit<
  VendorBastAcceptanceSignOffRecord,
  'signedAt'
> & { signedAt: string };

export type CanonicalVendorBastLink = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  bastNumber: string;
  acceptanceStatus: BastStatus;
};

/** Full compatibility read record. */
export type VendorBastRecord = {
  id: string;
  /** Safe canonical identity; suppressed for an unresolved/cross-scope link. */
  bastDocumentId: string | null;
  clientId: string;
  vendorWorkId: string;
  completionReportId: string | null;
  serviceReportId: string | null;
  workOrderId: string;
  buildingId: string;
  bastNumber: string;
  bastDate: string;
  preparedByUserId: string;
  submittedByUserId: string | null;
  acceptedByUserId: string | null;
  /** Canonical status when safely linked, otherwise a labelled legacy fallback. */
  acceptanceStatus: BastStatus;
  notes: string | null;
  fileReference: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  compatibility: VendorBastCompatibility;
  acceptanceSignOff: VendorBastAcceptanceSignOffRecord | null;
  /** Internal canonical context used only to determine safe write delegation. */
  canonicalLink: CanonicalVendorBastLink | null;
};

/** Safe public compatibility projection exposed through the legacy API. */
export type PublicVendorBast = Omit<
  VendorBastRecord,
  | 'submittedAt'
  | 'acceptedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'acceptanceSignOff'
  | 'canonicalLink'
> & {
  submittedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  acceptanceSignOff: PublicVendorBastAcceptanceSignOff | null;
};

/** Historical input retained for source compatibility; legacy create is restricted. */
export type CreateVendorBastInput = {
  vendorWorkId: string;
  bastNumber: string;
  bastDate: string;
  notes?: string | null;
  fileReference?: string | null;
  preparedByUserId: string;
};

/** List filters for GET /vendor-basts. */
export type VendorBastFilters = {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
};

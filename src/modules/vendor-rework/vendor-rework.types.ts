/**
 * BE-15J — Vendor Work Rework domain types.
 *
 * Append-preserving rework cycles for a BE-15B Vendor Work, anchored to the
 * BE-07 review (BE-15I verification) that produced REWORK_REQUIRED. No
 * separate Vendor rework engine exists here.
 *
 * Lifecycle: REQUESTED → RESUBMITTED. A RESUBMITTED cycle is immutable, so
 * previous rework cycles are never overwritten.
 */
export const VENDOR_REWORK_STATUSES = ['REQUESTED', 'RESUBMITTED'] as const;

export type VendorReworkStatus = (typeof VENDOR_REWORK_STATUSES)[number];

export function isVendorReworkStatus(value: unknown): value is VendorReworkStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_REWORK_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorReworkRecord = {
  id: string;
  vendorWorkId: string;
  reviewId: string;
  requestedByUserId: string;
  reason: string;
  reworkNotes: string | null;
  resubmittedByUserId: string | null;
  requestedAt: Date;
  resubmittedAt: Date | null;
  status: VendorReworkStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorRework = Omit<
  VendorReworkRecord,
  'requestedAt' | 'resubmittedAt' | 'createdAt' | 'updatedAt'
> & {
  requestedAt: string;
  resubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The resolved rework state of a Vendor Work. */
export type VendorReworkContext = {
  vendorWorkId: string;
  vendorWorkStatus: string;
  buildingId: string;
  current: PublicVendorRework | null;
  cycles: PublicVendorRework[];
};

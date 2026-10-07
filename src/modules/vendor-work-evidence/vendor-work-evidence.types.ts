/**
 * BE-15E — Vendor Work Evidence Binding domain types.
 *
 * Binds a BE-15B Vendor Work to the existing BE-07 shared evidence engine
 * (`evidence_requirements` + `evidence_submissions`). No separate Vendor
 * evidence engine is created: Vendor Work requirements target
 * `target_type = 'VENDOR_WORK'`, and submissions use
 * `execution_type = 'VENDOR_WORK'` with `execution_id = vendor_work_id`.
 */
export const VENDOR_WORK_EVIDENCE_TYPES = [
  'PHOTO',
  'DOCUMENT',
  'SIGNATURE',
] as const;

export type VendorWorkEvidenceType = (typeof VENDOR_WORK_EVIDENCE_TYPES)[number];

export function isVendorWorkEvidenceType(
  value: unknown,
): value is VendorWorkEvidenceType {
  return (
    typeof value === 'string' &&
    (VENDOR_WORK_EVIDENCE_TYPES as readonly string[]).includes(value)
  );
}

/** A BE-07 evidence requirement bound to a Vendor Work. */
export type PublicVendorWorkEvidenceRequirement = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  evidenceType: VendorWorkEvidenceType;
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
  status: string;
};

/** A BE-07 evidence submission bound to a Vendor Work. */
export type PublicVendorWorkEvidence = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  evidenceRequirementId: string | null;
  evidenceType: VendorWorkEvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  submittedByUserId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for submitting Vendor Work evidence. */
export type SubmitVendorWorkEvidenceInput = {
  vendorWorkId: string;
  /** Resolved by the service from the Vendor Work; callers may omit it. */
  clientId?: string;
  evidenceType: VendorWorkEvidenceType;
  evidenceRequirementId?: string;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt?: string;
  submittedByUserId: string;
};

/** List filters for GET /vendor-work-evidence. */
export type VendorWorkEvidenceFilters = {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
};

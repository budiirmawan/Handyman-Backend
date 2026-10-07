/**
 * BE-06H — Vendor License / Certification / Expiry domain types.
 *
 * A single table carries both LICENSE and CERTIFICATION records
 * (`recordType` is data, not a behavioral fork):
 *
 *   Vendor → Vendor License / Certification → validity / expiry status
 *
 * `documentReference` optionally points at an existing BE-06G
 * `vendor_compliance_documents` row — document storage is reused, never
 * duplicated here.
 *
 * Status:
 *   ACTIVE   — currently standing (expiry, if any, in the future at write
 *              time).
 *   EXPIRED  — the expiry date has passed; a historical record.
 *   INACTIVE — withdrawn/superseded; history.
 *
 * The *resolved* expiry status of a row at an instant (`expiryStatus`:
 * VALID / EXPIRED / NOT_APPLICABLE) is computed by the service — there is
 * no automatic renewal and no notification scheduler in this PART.
 */
export const VENDOR_LICENSE_RECORD_TYPES = [
  'LICENSE',
  'CERTIFICATION',
] as const;

export type VendorLicenseRecordType =
  (typeof VENDOR_LICENSE_RECORD_TYPES)[number];

export function isVendorLicenseRecordType(
  value: unknown,
): value is VendorLicenseRecordType {
  return (
    typeof value === 'string' &&
    (VENDOR_LICENSE_RECORD_TYPES as readonly string[]).includes(value)
  );
}

export const VENDOR_LICENSE_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'INACTIVE',
] as const;

export type VendorLicenseStatus = (typeof VENDOR_LICENSE_STATUSES)[number];

export function isVendorLicenseStatus(
  value: unknown,
): value is VendorLicenseStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_LICENSE_STATUSES as readonly string[]).includes(value)
  );
}

/** Resolved validity of a record at an evaluation instant. */
export const VENDOR_LICENSE_EXPIRY_STATUSES = [
  'VALID',
  'EXPIRED',
  'NOT_APPLICABLE',
] as const;

export type VendorLicenseExpiryStatus =
  (typeof VENDOR_LICENSE_EXPIRY_STATUSES)[number];

/** Full database record. */
export type VendorLicenseRecord = {
  id: string;
  vendorId: string;
  recordType: VendorLicenseRecordType;
  name: string;
  number: string;
  issuingAuthority: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  status: VendorLicenseStatus;
  documentReference: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation exposed through the API, including the
 * service-resolved `expiryStatus` at response time.
 */
export type PublicVendorLicense = {
  id: string;
  vendorId: string;
  recordType: VendorLicenseRecordType;
  name: string;
  number: string;
  issuingAuthority: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  status: VendorLicenseStatus;
  expiryStatus: VendorLicenseExpiryStatus;
  documentReference: string | null;
  notes: string | null;
};

export type CreateVendorLicenseInput = {
  vendorId: string;
  recordType: VendorLicenseRecordType;
  name: string;
  number: string;
  issuingAuthority?: string;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  status?: VendorLicenseStatus;
  documentReference?: string | null;
  notes?: string;
};

/** Fully-resolved record data ready for persistence. */
export type NewVendorLicense = {
  vendorId: string;
  recordType: VendorLicenseRecordType;
  name: string;
  number: string;
  issuingAuthority: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  status: VendorLicenseStatus;
  documentReference: string | null;
  notes: string | null;
};

/**
 * Partial update. `vendorId` and `recordType` are deliberately immutable —
 * a record never migrates between Vendors and never mutates between
 * LICENSE and CERTIFICATION. `null` clears an optional field.
 */
export type UpdateVendorLicenseInput = {
  name?: string;
  number?: string;
  issuingAuthority?: string | null;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  status?: VendorLicenseStatus;
  documentReference?: string | null;
  notes?: string | null;
};

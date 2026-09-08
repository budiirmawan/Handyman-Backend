/**
 * BE-06G — Vendor Compliance Document domain types.
 *
 * Structured compliance METADATA for a Vendor (business license record,
 * tax compliance letter, insurance certificate, …):
 *
 *   Vendor → Vendor Compliance Document
 *
 * Only metadata plus an opaque `fileReference` pointer are held — never a
 * binary, and never a document-management platform. No OCR, parsing,
 * approval workflow, renewal automation, or License/Certification/Expiry
 * engine (BE-06H) lives here.
 *
 * Status:
 *   ACTIVE   — the document currently stands (expiry, if any, is in the
 *              future at write time).
 *   EXPIRED  — the document's expiry date has passed.
 *   INACTIVE — withdrawn/superseded; kept as history.
 */
export const VENDOR_COMPLIANCE_DOCUMENT_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'INACTIVE',
] as const;

export type VendorComplianceDocumentStatus =
  (typeof VENDOR_COMPLIANCE_DOCUMENT_STATUSES)[number];

export function isVendorComplianceDocumentStatus(
  value: unknown,
): value is VendorComplianceDocumentStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_COMPLIANCE_DOCUMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorComplianceDocumentRecord = {
  id: string;
  vendorId: string;
  documentType: string;
  documentNumber: string;
  documentName: string;
  issueDate: Date | null;
  expiryDate: Date | null;
  status: VendorComplianceDocumentStatus;
  fileReference: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorComplianceDocument = {
  id: string;
  vendorId: string;
  documentType: string;
  documentNumber: string;
  documentName: string;
  issueDate: Date | null;
  expiryDate: Date | null;
  status: VendorComplianceDocumentStatus;
  fileReference: string | null;
  notes: string | null;
};

export type CreateVendorComplianceDocumentInput = {
  vendorId: string;
  documentType: string;
  documentNumber: string;
  documentName: string;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  status?: VendorComplianceDocumentStatus;
  fileReference?: string;
  notes?: string;
};

/** Fully-resolved document data ready for persistence. */
export type NewVendorComplianceDocument = {
  vendorId: string;
  documentType: string;
  documentNumber: string;
  documentName: string;
  issueDate: Date | null;
  expiryDate: Date | null;
  status: VendorComplianceDocumentStatus;
  fileReference: string | null;
  notes: string | null;
};

/**
 * Partial metadata/status update. `vendorId` is deliberately immutable —
 * a document never migrates between Vendors. `null` clears an optional
 * field. Status changes travel through the same endpoint.
 */
export type UpdateVendorComplianceDocumentInput = {
  documentType?: string;
  documentNumber?: string;
  documentName?: string;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  status?: VendorComplianceDocumentStatus;
  fileReference?: string | null;
  notes?: string | null;
};

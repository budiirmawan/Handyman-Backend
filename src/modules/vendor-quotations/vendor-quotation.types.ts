/**
 * CR-BE-PRO-02 PART 03 — Vendor Quotation + immutable revisions.
 *
 * A quotation is only a response to an existing RFQ Vendor Invitation.
 * Submitted revisions are historical commercial evidence and are never
 * overwritten. No comparison, recommendation, award, PO, budget, or
 * commitment behavior belongs here.
 */

export const VENDOR_QUOTATION_STATUSES = ['DRAFT', 'SUBMITTED', 'WITHDRAWN'] as const;
export type VendorQuotationStatus = (typeof VENDOR_QUOTATION_STATUSES)[number];

export const VENDOR_QUOTATION_REVISION_STATUSES = ['DRAFT', 'SUBMITTED', 'SUPERSEDED'] as const;
export type VendorQuotationRevisionStatus =
  (typeof VENDOR_QUOTATION_REVISION_STATUSES)[number];

export const VENDOR_QUOTATION_TECHNICAL_COMPLIANCE = [
  'COMPLIANT',
  'NON_COMPLIANT',
  'NOT_STATED',
] as const;
export type VendorQuotationTechnicalCompliance =
  (typeof VENDOR_QUOTATION_TECHNICAL_COMPLIANCE)[number];

export function isVendorQuotationTechnicalCompliance(value: unknown): value is VendorQuotationTechnicalCompliance {
  return typeof value === 'string' && (VENDOR_QUOTATION_TECHNICAL_COMPLIANCE as readonly string[]).includes(value);
}

export type VendorQuotationRecord = {
  id: string;
  rfqId: string;
  invitationId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  quotationNumber: string;
  status: VendorQuotationStatus;
  createdBySessionId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
};

export type VendorQuotationRevisionRecord = {
  id: string;
  quotationId: string;
  rfqId: string;
  invitationId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  revisionNumber: number;
  status: VendorQuotationRevisionStatus;
  currency: string;
  validUntil: string | null;
  leadTimeDays: number | null;
  deliveryTerms: string | null;
  serviceTerms: string | null;
  notes: string | null;
  createdBySessionId: string;
  submittedAt: Date | null;
  submittedBySessionId: string | null;
  supersededAt: Date | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
};

export type VendorQuotationLineRecord = {
  id: string;
  quotationRevisionId: string;
  quotationId: string;
  rfqId: string;
  rfqLineId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumberSnapshot: number;
  description: string | null;
  requiredQuantitySnapshot: number | null;
  requiredUomId: string | null;
  /**
   * CR-BE-SVC-01 PART 04 — governed SERVICE identity snapshot, propagated from
   * the RFQ line. NULL for MATERIAL lines and un-governed SERVICE lines. The
   * Vendor cannot set it; it is derived from the RFQ line and frozen.
   */
  sourceServiceId: string | null;
  quotedQuantity: number | null;
  unitPrice: number;
  lineTotal: number;
  technicalCompliance: VendorQuotationTechnicalCompliance;
  deviationNotes: string | null;
  createdBySessionId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicVendorQuotationLine = Omit<
  VendorQuotationLineRecord,
  'createdBySessionId' | 'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicVendorQuotationRevision = Omit<
  VendorQuotationRevisionRecord,
  | 'createdBySessionId'
  | 'submittedBySessionId'
  | 'submittedAt'
  | 'supersededAt'
  | 'idempotencyKey'
  | 'idempotencyFingerprint'
  | 'createdAt'
  | 'updatedAt'
> & {
  submittedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
  totalAmount: number;
  lines: PublicVendorQuotationLine[];
  attachments: PublicQuotationAttachment[];
};

export type PublicVendorQuotation = Omit<
  VendorQuotationRecord,
  | 'createdBySessionId'
  | 'idempotencyKey'
  | 'idempotencyFingerprint'
  | 'createdAt'
  | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
  currentRevision: PublicVendorQuotationRevision | null;
};

export type CreateVendorQuotationInput = {
  invitationId: string;
  quotationNumber?: string;
  currency: string;
  validUntil?: string | null;
  leadTimeDays?: number | null;
  deliveryTerms?: string | null;
  serviceTerms?: string | null;
  notes?: string | null;
  idempotencyKey: string;
  lines: CreateVendorQuotationLineInput[];
};

export type CreateVendorQuotationLineInput = {
  rfqLineId: string;
  quotedQuantity?: number | null;
  unitPrice: number;
  description?: string | null;
  technicalCompliance?: VendorQuotationTechnicalCompliance;
  deviationNotes?: string | null;
};

export type UpdateVendorQuotationRevisionInput = {
  currency?: string;
  validUntil?: string | null;
  leadTimeDays?: number | null;
  deliveryTerms?: string | null;
  serviceTerms?: string | null;
  notes?: string | null;
};

export type CreateVendorQuotationRevisionInput = {
  quotationId: string;
  currency: string;
  validUntil?: string | null;
  leadTimeDays?: number | null;
  deliveryTerms?: string | null;
  serviceTerms?: string | null;
  notes?: string | null;
  idempotencyKey: string;
  lines: CreateVendorQuotationLineInput[];
};

export type UpdateVendorQuotationLineInput = {
  quotedQuantity?: number | null;
  unitPrice?: number;
  description?: string | null;
  technicalCompliance?: VendorQuotationTechnicalCompliance;
  deviationNotes?: string | null;
};

export type VendorQuotationFilters = {
  vendorId?: string;
  status?: VendorQuotationStatus;
};

export type CreateQuotationAttachmentInput = {
  quotationRevisionId: string;
  documentNumber: string;
  documentType: string;
  title: string;
  description?: string | null;
  fileReference: string;
};

export type PublicQuotationAttachment = {
  supportingDocumentId: string;
  documentId: string;
  parentType: 'QUOTATION_REVISION';
  parentId: string;
  documentNumber: string;
  documentType: string;
  title: string;
  description: string | null;
  fileReference: string | null;
  status: string;
};

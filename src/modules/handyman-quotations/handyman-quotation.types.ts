import type { PriceCatalogCurrency } from '../price-catalog-entries';

/**
 * CR-HM-BE-03 RUN 2 — Customer quotation types.
 *
 * One quotation identity supports the whole commercial revision loop;
 * SUBMITTED revision facts are immutable; a SENT quotation binds exactly one
 * SUBMITTED revision. No approval vocabulary exists in this run — APPROVED /
 * REJECTED / EXPIRED are reserved envelope states governed by later runs.
 */

export const HANDYMAN_QUOTATION_STATUSES = [
  'DRAFT',
  'SENT',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
  'CANCELLED',
] as const;
export type HandymanQuotationStatus = (typeof HANDYMAN_QUOTATION_STATUSES)[number];

/** Envelope states from which a send is governed in Run 2. */
export const HANDYMAN_QUOTATION_SENDABLE_STATUSES = [
  'DRAFT',
  'WITHDRAWN',
  // CR-HM-BE-03 RUN 3: a REJECTED quotation re-quotes under the SAME
  // identity — the governed reopen transition (next DRAFT revision) returns
  // the request to its authoring phase and the envelope re-sends from
  // REJECTED. APPROVED remains final.
  'REJECTED',
] as const;

export const HANDYMAN_QUOTATION_REVISION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'SUPERSEDED',
] as const;
export type HandymanQuotationRevisionStatus =
  (typeof HANDYMAN_QUOTATION_REVISION_STATUSES)[number];

export const HANDYMAN_QUOTATION_LINE_TYPES = ['LABOR', 'MATERIAL', 'OTHER'] as const;
export type HandymanQuotationLineType = (typeof HANDYMAN_QUOTATION_LINE_TYPES)[number];

/** Storable lookup resolutions; anything else fails closed in the service. */
export const HANDYMAN_QUOTATION_REFERENCE_RESOLUTIONS = [
  'MATCHED',
  'NO_REFERENCE_PRICE',
] as const;
export type HandymanQuotationReferenceResolution =
  (typeof HANDYMAN_QUOTATION_REFERENCE_RESOLUTIONS)[number];

export type HandymanQuotationRecord = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  quotationNumber: string;
  currency: PriceCatalogCurrency;
  status: HandymanQuotationStatus;
  tenantCompanyId: string | null;
  tenantPicId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  sentRevisionId: string | null;
  sentAt: Date | null;
  withdrawnAt: Date | null;
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanQuotationRevisionRecord = {
  id: string;
  quotationId: string;
  clientId: string;
  buildingId: string;
  revisionNumber: number;
  status: HandymanQuotationRevisionStatus;
  notes: string | null;
  validUntil: string | null;
  submittedAt: Date | null;
  submittedByUserId: string | null;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanQuotationLineRecord = {
  id: string;
  quotationRevisionId: string;
  quotationId: string;
  clientId: string;
  buildingId: string;
  lineNumber: number;
  lineType: HandymanQuotationLineType;
  serviceCatalogId: string | null;
  inventoryItemId: string | null;
  uomId: string | null;
  quantity: string | null;
  subjectCode: string | null;
  subjectName: string | null;
  uomCode: string | null;
  description: string | null;
  unitPrice: string;
  lineTotal: string;
  referenceResolution: HandymanQuotationReferenceResolution | null;
  referencePriceEntryId: string | null;
  referenceScopeTier: string | null;
  referenceUnitPrice: string | null;
  referenceAsOf: Date | null;
  deviationNote: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Totals derived from governed lines — never caller-authoritative. */
export type HandymanQuotationTotals = {
  laborTotal: number;
  materialTotal: number;
  otherTotal: number;
  grandTotal: number;
};

export type PublicHandymanQuotation = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  quotationNumber: string;
  currency: PriceCatalogCurrency;
  status: HandymanQuotationStatus;
  tenantCompanyId: string | null;
  tenantPicId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  sentRevisionId: string | null;
  sentAt: string | null;
  withdrawnAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicHandymanQuotationRevision = {
  id: string;
  quotationId: string;
  clientId: string;
  buildingId: string;
  revisionNumber: number;
  status: HandymanQuotationRevisionStatus;
  notes: string | null;
  validUntil: string | null;
  submittedAt: string | null;
  submittedByUserId: string | null;
  supersededAt: string | null;
  supersededByUserId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  totals: HandymanQuotationTotals;
};

export type PublicHandymanQuotationLine = {
  id: string;
  quotationRevisionId: string;
  quotationId: string;
  lineNumber: number;
  lineType: HandymanQuotationLineType;
  serviceCatalogId: string | null;
  inventoryItemId: string | null;
  uomId: string | null;
  quantity: number | null;
  subjectCode: string | null;
  subjectName: string | null;
  uomCode: string | null;
  description: string | null;
  unitPrice: number;
  lineTotal: number;
  referenceResolution: HandymanQuotationReferenceResolution | null;
  referencePriceEntryId: string | null;
  referenceScopeTier: string | null;
  referenceUnitPrice: number | null;
  referenceAsOf: string | null;
  deviationNote: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Command inputs — actor identity is always a separate parameter. */
export type CreateHandymanQuotationInput = {
  requestId: string;
  currency: PriceCatalogCurrency;
  idempotencyKey?: string | null;
};

export type CreateHandymanQuotationRevisionInput = {
  quotationId: string;
  notes?: string | null;
  validUntil?: string | null;
};

export type AddHandymanQuotationLineInput = {
  revisionId: string;
  lineType: HandymanQuotationLineType;
  serviceCatalogId?: string | null;
  inventoryItemId?: string | null;
  uomId?: string | null;
  quantity?: number | string | null;
  description?: string | null;
  unitPrice: number | string;
  deviationNote?: string | null;
};

export type UpdateHandymanQuotationLineInput = {
  unitPrice?: number | string;
  quantity?: number | string | null;
  description?: string | null;
  deviationNote?: string | null;
};

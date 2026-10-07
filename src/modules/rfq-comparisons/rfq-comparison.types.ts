/**
 * CR-BE-PRO-02 PART 04 — deterministic quotation comparison and explicit
 * human evaluation. A comparison is evidence, not a recommendation or award.
 */

export const RFQ_COMPARISON_STATUSES = ['SNAPSHOT'] as const;
export type RfqComparisonStatus = (typeof RFQ_COMPARISON_STATUSES)[number];

export const RFQ_COMPARISON_LINE_STATUSES = ['QUOTED', 'MISSING'] as const;
export type RfqComparisonLineStatus = (typeof RFQ_COMPARISON_LINE_STATUSES)[number];

/**
 * CR-BE-PRICE-01 PART 04 — advisory reference-price snapshot outcomes.
 * Frozen at run creation; never re-derived. `NOT_REQUESTED` covers SERVICE
 * lines (the price authority is MATERIAL-only); a NULL resolution on a
 * stored row means the run predates PART 04.
 */
export const RFQ_COMPARISON_REFERENCE_RESOLUTIONS = [
  'MATCHED',
  'NO_REFERENCE_PRICE',
  'UOM_INCOMPATIBLE',
  'CURRENCY_INCOMPATIBLE',
  'NOT_REQUESTED',
] as const;
export type RfqComparisonReferenceResolution =
  (typeof RFQ_COMPARISON_REFERENCE_RESOLUTIONS)[number];

export const RFQ_COMPARISON_REFERENCE_POSITIONS = [
  'ABOVE',
  'BELOW',
  'EQUAL',
] as const;
export type RfqComparisonReferencePosition =
  (typeof RFQ_COMPARISON_REFERENCE_POSITIONS)[number];

/** Advisory snapshot facts. All fact fields are null unless MATCHED. */
export type RfqComparisonLineReference = {
  priceEntryId: string | null;
  unitPrice: number | null;
  currency: string | null;
  uomId: string | null;
  scopeVendor: boolean | null;
  scopeBuilding: boolean | null;
  effectiveFrom: Date | null;
  resolution: RfqComparisonReferenceResolution | null;
  referenceTotal: number | null;
  unitVariance: number | null;
  totalVariance: number | null;
  variancePercent: number | null;
  position: RfqComparisonReferencePosition | null;
};

export const EMPTY_REFERENCE: RfqComparisonLineReference = {
  priceEntryId: null,
  unitPrice: null,
  currency: null,
  uomId: null,
  scopeVendor: null,
  scopeBuilding: null,
  effectiveFrom: null,
  resolution: null,
  referenceTotal: null,
  unitVariance: null,
  totalVariance: null,
  variancePercent: null,
  position: null,
};

export type RfqComparisonRunRecord = {
  id: string;
  rfqId: string;
  clientId: string;
  buildingId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  currency: string;
  rfqNumberSnapshot: string;
  status: RfqComparisonStatus;
  snapshotAt: Date;
  createdByUserId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
};

export type RfqComparisonEvidenceRecord = {
  id: string;
  comparisonRunId: string;
  rfqId: string;
  invitationId: string;
  quotationId: string;
  quotationRevisionId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  quotationNumberSnapshot: string;
  revisionNumberSnapshot: number;
  submittedAt: Date;
  currency: string;
  validUntil: string | null;
  leadTimeDays: number | null;
  deliveryTerms: string | null;
  serviceTerms: string | null;
  notes: string | null;
  totalAmount: number;
  createdAt: Date;
};

export type RfqComparisonLineRecord = {
  id: string;
  comparisonRunId: string;
  evidenceId: string;
  rfqId: string;
  rfqLineId: string;
  quotationLineId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  rfqLineNumberSnapshot: number;
  descriptionSnapshot: string;
  offeredDescriptionSnapshot: string | null;
  requiredQuantitySnapshot: number | null;
  requiredUomId: string | null;
  quotedQuantitySnapshot: number | null;
  unitPrice: number;
  lineTotal: number;
  technicalCompliance: 'COMPLIANT' | 'NON_COMPLIANT' | 'NOT_STATED';
  deviationNotes: string | null;
  lineStatus: RfqComparisonLineStatus;
  reference: RfqComparisonLineReference;
  createdAt: Date;
};

export type RfqComparisonAttachmentReference = {
  id: string;
  comparisonRunId: string;
  evidenceId: string;
  supportingDocumentId: string;
  documentId: string;
  createdAt: Date;
};

export type RfqComparisonEvaluationRecord = {
  id: string;
  comparisonRunId: string;
  evidenceId: string;
  rfqId: string;
  vendorId: string;
  quotationRevisionId: string;
  commercialObservation: string | null;
  technicalObservation: string | null;
  complianceObservation: string | null;
  evaluatorNote: string | null;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateRfqComparisonInput = {
  rfqId: string;
  idempotencyKey: string;
};

export type CreateRfqEvaluationInput = {
  comparisonRunId: string;
  evidenceId?: string;
  vendorId?: string;
  commercialObservation?: string | null;
  technicalObservation?: string | null;
  complianceObservation?: string | null;
  evaluatorNote?: string | null;
};

export type UpdateRfqEvaluationInput = {
  commercialObservation?: string | null;
  technicalObservation?: string | null;
  complianceObservation?: string | null;
  evaluatorNote?: string | null;
};

export type PublicRfqComparisonAttachmentReference = {
  supportingDocumentId: string;
  documentId: string;
};

/** PART 04 public advisory snapshot (§12); present only under `price_catalog.read`. */
export type PublicRfqComparisonLineReference = Omit<
  RfqComparisonLineReference,
  'effectiveFrom'
> & { effectiveFrom: string | null };

export type PublicRfqComparisonLineOffer = {
  evidenceId: string;
  vendorId: string;
  invitationId: string;
  quotationId: string;
  quotationRevisionId: string;
  revisionNumber: number;
  submittedAt: string;
  quotedQuantity: number | null;
  unitPrice: number;
  lineTotal: number;
  technicalCompliance: 'COMPLIANT' | 'NON_COMPLIANT' | 'NOT_STATED';
  deviationNotes: string | null;
  /** PART 04: present only when the caller also holds `price_catalog.read`. */
  reference?: PublicRfqComparisonLineReference;
};

export type PublicRfqComparisonLine = {
  rfqLineId: string;
  lineNumber: number;
  sourceMode: 'MATERIAL' | 'SERVICE';
  description: string;
  requiredQuantity: number | null;
  requiredUomId: string | null;
  offers: PublicRfqComparisonLineOffer[];
  lowestQuotedUnitPrice: number | null;
  highestQuotedUnitPrice: number | null;
  priceDelta: number | null;
  percentageDelta: number | null;
};

export type PublicRfqComparisonEvidence = {
  evidenceId: string;
  vendorId: string;
  invitationId: string;
  quotationId: string;
  quotationRevisionId: string;
  quotationNumber: string;
  revisionNumber: number;
  submittedAt: string;
  currency: string;
  validUntil: string | null;
  leadTimeDays: number | null;
  deliveryTerms: string | null;
  serviceTerms: string | null;
  notes: string | null;
  totalAmount: number;
  lines: Array<{
    quotationLineId: string;
    rfqLineId: string;
    lineNumber: number;
    sourceMode: 'MATERIAL' | 'SERVICE';
    description: string;
    offeredDescription: string | null;
    requiredQuantity: number | null;
    requiredUomId: string | null;
    quotedQuantity: number | null;
    unitPrice: number;
    lineTotal: number;
    technicalCompliance: 'COMPLIANT' | 'NON_COMPLIANT' | 'NOT_STATED';
    deviationNotes: string | null;
    lineStatus: RfqComparisonLineStatus;
  }>;
  attachments: PublicRfqComparisonAttachmentReference[];
};

export type PublicRfqComparisonEvaluation = {
  id: string;
  comparisonRunId: string;
  evidenceId: string;
  rfqId: string;
  vendorId: string;
  quotationRevisionId: string;
  commercialObservation: string | null;
  technicalObservation: string | null;
  complianceObservation: string | null;
  evaluatorNote: string | null;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicRfqComparison = {
  id: string;
  rfqId: string;
  clientId: string;
  buildingId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  currency: string;
  rfqNumber: string;
  status: RfqComparisonStatus;
  snapshotAt: string;
  createdByUserId: string;
  createdAt: string;
  evidence: PublicRfqComparisonEvidence[];
  lines: PublicRfqComparisonLine[];
  commercial: {
    lowestTotalQuotations: Array<{
      evidenceId: string;
      vendorId: string;
      totalAmount: number;
    }>;
    lowestTotalAmount: number | null;
    highestTotalAmount: number | null;
    totalPriceSpread: number | null;
  };
  evaluations: PublicRfqComparisonEvaluation[];
};

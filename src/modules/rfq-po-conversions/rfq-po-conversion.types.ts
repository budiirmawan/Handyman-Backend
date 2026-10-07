import type { PublicPurchaseOrder } from '../purchase-orders';
import type { PublicPurchaseOrderLine } from '../purchase-orders';

/**
 * CR-BE-PRO-02 PART 06 — typed lineage from one finalized RFQ award to the
 * existing Purchase Order. This stores no alternate commercial authority.
 */
export type RfqAwardPoConversionRecord = {
  id: string;
  awardId: string;
  recommendationId: string;
  rfqId: string;
  clientId: string;
  buildingId: string;
  comparisonRunId: string;
  evidenceId: string;
  quotationId: string;
  quotationRevisionId: string;
  invitationId: string;
  vendorId: string;
  poReadinessId: string;
  purchaseOrderId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  convertedByUserId: string;
  convertedAt: Date;
};

export type RfqAwardPoLineProvenanceRecord = {
  id: string;
  conversionId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  rfqId: string;
  rfqLineId: string;
  quotationLineId: string;
  quotationRevisionId: string;
  createdAt: Date;
};

export type CreateRfqPoConversionInput = {
  awardId: string;
  poReadinessId: string;
  poNumber: string;
  poDate: string;
  idempotencyKey: string;
  notes?: string | null;
};

export type PublicRfqPoLineProvenance = Omit<RfqAwardPoLineProvenanceRecord, 'createdAt'> & {
  createdAt: string;
};

export type PublicRfqPoConversion = Omit<RfqAwardPoConversionRecord, 'convertedAt' | 'idempotencyKey' | 'idempotencyFingerprint'> & {
  convertedAt: string;
  purchaseOrder: PublicPurchaseOrder;
  purchaseOrderLines: PublicPurchaseOrderLine[];
  lineProvenance: PublicRfqPoLineProvenance[];
};

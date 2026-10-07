/**
 * CR-BE-PRO-02 PART 05 — an accountable human recommendation and explicit
 * award. A recommendation never derives a Vendor from comparison arithmetic.
 */

export const RFQ_RECOMMENDATION_OUTCOMES = ['VENDOR', 'NO_AWARD'] as const;
export type RfqRecommendationOutcome = (typeof RFQ_RECOMMENDATION_OUTCOMES)[number];

export const RFQ_RECOMMENDATION_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'AWARDED',
] as const;
export type RfqRecommendationStatus = (typeof RFQ_RECOMMENDATION_STATUSES)[number];

export const RFQ_AWARD_OUTCOMES = ['VENDOR', 'NO_AWARD'] as const;
export type RfqAwardOutcome = (typeof RFQ_AWARD_OUTCOMES)[number];

export type RfqRecommendationRecord = {
  id: string;
  rfqId: string;
  clientId: string;
  buildingId: string;
  comparisonRunId: string;
  evidenceId: string | null;
  quotationId: string | null;
  quotationRevisionId: string | null;
  invitationId: string | null;
  vendorId: string | null;
  outcome: RfqRecommendationOutcome;
  status: RfqRecommendationStatus;
  reason: string;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type RfqAwardRecord = {
  id: string;
  rfqId: string;
  clientId: string;
  buildingId: string;
  recommendationId: string;
  approvalId: string;
  comparisonRunId: string;
  evidenceId: string | null;
  quotationId: string | null;
  quotationRevisionId: string | null;
  invitationId: string | null;
  vendorId: string | null;
  outcome: RfqAwardOutcome;
  awardReason: string | null;
  awardedByUserId: string;
  awardedAt: Date;
};

export type CreateRfqRecommendationInput = {
  rfqId: string;
  comparisonRunId: string;
  evidenceId?: string;
  vendorId?: string;
  quotationRevisionId?: string;
  outcome?: RfqRecommendationOutcome;
  reason: string;
  notes?: string | null;
};

export type PublicRfqRecommendation = Omit<
  RfqRecommendationRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type PublicRfqAward = Omit<RfqAwardRecord, 'awardedAt'> & {
  awardedAt: string;
};

export type CreateRfqAwardInput = {
  recommendationId: string;
  awardReason?: string | null;
};

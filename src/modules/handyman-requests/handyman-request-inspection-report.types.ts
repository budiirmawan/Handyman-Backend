import type { HandymanScopeClassification } from './handyman-request-diagnosis.types';

/**
 * CR-HM-INSPECTION-01 PART B — versioned Field inspection report types.
 *
 * A report version is the assigned Field inspector's immutable technical
 * record for the request's single 0381 physical inspection. It carries
 * technical scope only: bounded findings, the proposed diagnosis/discipline
 * anchor, and LABOR/MATERIAL estimated quantities with an existing
 * unit-of-measure reference. There is NO price, amount, currency, tax,
 * markup or supplier field anywhere in this model, and nothing here is a
 * quotation line or a CR-HM-12 pricing basis.
 *
 * Nothing in this model is a request status: report state is DERIVED from
 * the immutable review row (FROZEN F1 is untouched).
 */

export const HANDYMAN_INSPECTION_ESTIMATE_LINE_TYPES = [
  'LABOR',
  'MATERIAL',
] as const;
export type HandymanInspectionEstimateLineType =
  (typeof HANDYMAN_INSPECTION_ESTIMATE_LINE_TYPES)[number];

export function isHandymanInspectionEstimateLineType(
  value: unknown,
): value is HandymanInspectionEstimateLineType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_INSPECTION_ESTIMATE_LINE_TYPES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_INSPECTION_REVIEW_DECISIONS = [
  'ACCEPTED',
  'RETURNED',
] as const;
export type HandymanInspectionReviewDecision =
  (typeof HANDYMAN_INSPECTION_REVIEW_DECISIONS)[number];

/** Derived report state; never persisted as a mutable status column. */
export type HandymanInspectionReportStatus =
  | 'PENDING_REVIEW'
  | 'ACCEPTED'
  | 'RETURNED';

/** Bounded technical estimate line (quantity only — never a price). */
export type HandymanInspectionReportEstimateRecord = {
  id: string;
  /** Verbatim snapshot of the request's tenant-isolation root. */
  clientId: string;
  reportId: string;
  lineType: HandymanInspectionEstimateLineType;
  description: string;
  quantity: number;
  /** Existing `units_of_measure` master reference (never free text). */
  uomId: string;
  createdAt: Date;
};

/** Immutable report VERSION (append-only; corrections append a new row). */
export type HandymanInspectionReportRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  channelAttributionId: string;
  buildingId: string;
  /** The ONE 0381 physical inspection this report documents. */
  handymanRequestInspectionId: string;
  /** The assignment fact the submitter acted under. */
  inspectionAssignmentId: string;
  versionNumber: number;
  supersedesReportId: string | null;
  /** Authenticated assigned Field user (FROZEN F7). */
  submittedByUserId: string;
  submittedAt: Date;
  technicalFindings: string;
  proposedDiagnosis: string;
  handymanDisciplineId: string;
  disciplineCode: string;
  /** Server-derived F9 snapshot — never a caller input. */
  scopeClassification: HandymanScopeClassification;
  recommendedServiceCatalogId: string | null;
};

/** Exactly one immutable decision per report version. */
export type HandymanInspectionReportReviewRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  buildingId: string;
  reportId: string;
  /** The version's submitter, copied by the server (separation proof). */
  reportSubmittedByUserId: string;
  decision: HandymanInspectionReviewDecision;
  returnReason: string | null;
  reviewedByUserId: string;
  reviewedAt: Date;
};

/** Caller input for a new report version (context/actor are NEVER input). */
export type SubmitHandymanInspectionReportInput = {
  handymanRequestId: string;
  technicalFindings: string;
  proposedDiagnosis: string;
  disciplineId: string;
  recommendedServiceCatalogId?: string;
  estimates?: ReadonlyArray<{
    lineType: HandymanInspectionEstimateLineType;
    description: string;
    quantity: number;
    uomId: string;
  }>;
};

/** Caller input for the review decision. */
export type ReviewHandymanInspectionReportInput = {
  handymanRequestId: string;
  reportId: string;
  decision: HandymanInspectionReviewDecision;
  returnReason?: string;
};

export type NewHandymanInspectionReportRecord = Omit<
  HandymanInspectionReportRecord,
  'id' | 'submittedAt'
> & { id: string };

export type NewHandymanInspectionReportEstimateRecord = Omit<
  HandymanInspectionReportEstimateRecord,
  'id' | 'createdAt'
> & { id: string };

export type NewHandymanInspectionReportReviewRecord = Omit<
  HandymanInspectionReportReviewRecord,
  'id' | 'reviewedAt'
> & { id: string };

/** Safe public representations (timestamps ISO; omitted where internal). */
export type PublicHandymanInspectionReportEstimate = Omit<
  HandymanInspectionReportEstimateRecord,
  'createdAt'
> & { createdAt: string };

export type PublicHandymanInspectionReportReview = Omit<
  HandymanInspectionReportReviewRecord,
  'reviewedAt'
> & { reviewedAt: string };

/** Report version + derived state + its lines and decision. */
export type PublicHandymanInspectionReport = Omit<
  HandymanInspectionReportRecord,
  'submittedAt'
> & {
  submittedAt: string;
  status: HandymanInspectionReportStatus;
  estimates: PublicHandymanInspectionReportEstimate[];
  review: PublicHandymanInspectionReportReview | null;
};

export type PublicHandymanInspectionReportThread = {
  reports: PublicHandymanInspectionReport[];
};

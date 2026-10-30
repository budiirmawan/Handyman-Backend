export const HANDYMAN_SCOPE_VARIATION_TYPES = ['ADD', 'REDUCE'] as const;
export type HandymanScopeVariationType =
  (typeof HANDYMAN_SCOPE_VARIATION_TYPES)[number];

export const HANDYMAN_SCOPE_VARIATION_LINE_TYPES = [
  'LABOR',
  'MATERIAL',
] as const;
export type HandymanScopeVariationLineType =
  (typeof HANDYMAN_SCOPE_VARIATION_LINE_TYPES)[number];

export const HANDYMAN_SCOPE_VARIATION_STATUSES = [
  'FIELD_FINDING',
  'PROPOSAL',
  'OPERATIONS_REVIEW',
  'REVISED_QUOTATION',
  'TENANT_DECISION',
  'AUTHORIZED_SCOPE',
  'EXECUTION',
  'QC',
  'FINAL_CHARGE_ELIGIBILITY',
] as const;
export type HandymanScopeVariationStatus =
  (typeof HANDYMAN_SCOPE_VARIATION_STATUSES)[number];

export const HANDYMAN_SCOPE_VARIATION_ACTOR_ROLES = [
  'PIC_PEKERJAAN',
  'INSPECTOR',
  'OPERATIONS_MANAGER',
  'SUPERVISOR',
  'TENANT',
] as const;
export type HandymanScopeVariationActorRole =
  (typeof HANDYMAN_SCOPE_VARIATION_ACTOR_ROLES)[number];

export const HANDYMAN_SCOPE_VARIATION_TENANT_DECISIONS = [
  'APPROVED',
  'REJECTED',
] as const;
export type HandymanScopeVariationTenantDecision =
  (typeof HANDYMAN_SCOPE_VARIATION_TENANT_DECISIONS)[number];

export const HANDYMAN_SCOPE_VARIATION_QC_OUTCOMES = [
  'PASSED',
  'FAILED',
] as const;
export type HandymanScopeVariationQcOutcome =
  (typeof HANDYMAN_SCOPE_VARIATION_QC_OUTCOMES)[number];

export interface HandymanScopeVariationRecord {
  id: string;
  clientId: string;
  executionScopeId: string;
  handymanRequestId: string;
  tenantCompanyId: string;
  buildingId: string;
  variationType: HandymanScopeVariationType;
  lineType: HandymanScopeVariationLineType;
  targetQuotationLineId: string | null;
  revisedQuotationVersionId: string | null;
  title: string;
  description: string;
  technicalFinding: string;
  quantity: string;
  uomId: string;
  quotedUnitAmount: string | null;
  quotedTotalDelta: string | null;
  currency: string | null;
  status: HandymanScopeVariationStatus;
  tenantDecisionOutcome: HandymanScopeVariationTenantDecision | null;
  tenantDecidedByUserId: string | null;
  tenantDecidedAt: string | null;
  qcOutcome: HandymanScopeVariationQcOutcome | null;
  qcRunId: string | null;
  qcVerifiedByUserId: string | null;
  qcVerifiedAt: string | null;
  bastId: string | null;
  finalChargeEligible: boolean;
  invoiced: boolean;
  originActorUserId: string;
  originActorRole: 'PIC_PEKERJAAN' | 'INSPECTOR';
  latestEvidenceReference: string;
  createIdempotencyKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HandymanScopeVariationEventRecord {
  id: string;
  clientId: string;
  variationId: string;
  executionScopeId: string;
  eventType: HandymanScopeVariationStatus;
  fromStatus: HandymanScopeVariationStatus | null;
  toStatus: HandymanScopeVariationStatus;
  actorUserId: string;
  actorRole: HandymanScopeVariationActorRole;
  evidenceReference: string;
  notes: string | null;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface FieldScopeVariationProjection {
  id: string;
  executionScopeId: string;
  handymanRequestId: string;
  variationType: HandymanScopeVariationType;
  lineType: HandymanScopeVariationLineType;
  targetQuotationLineId: string | null;
  /** Non-price identifiers for an explicitly offered ADD labor or material line. */
  revisedQuotationVersionId?: string | null;
  revisedQuotationLineId?: string;
  workOrderId?: string;
  approvedVariationVersion?: number;
  title: string;
  description: string;
  technicalFinding: string;
  quantity: string;
  uomId: string;
  status: HandymanScopeVariationStatus;
  tenantDecisionOutcome: HandymanScopeVariationTenantDecision | null;
  qcOutcome: HandymanScopeVariationQcOutcome | null;
  qcRunId: string | null;
  originActorUserId: string;
  originActorRole: 'PIC_PEKERJAAN' | 'INSPECTOR';
  latestEvidenceReference: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  events: HandymanScopeVariationEventRecord[];
}

export interface ReconciledOriginalLineProjection {
  quotationLineId: string;
  lineNumber: number;
  lineType: string;
  description: string;
  uomId: string;
  originalQuantity: string;
  authorizedReducedQuantity: string;
  remainingAuthorizedQuantity: string;
}

export interface ReconciledAuthorizedScopeProjection {
  executionScopeId: string;
  approvedQuotationVersionId: string;
  originalApprovedLinesImmutable: boolean;
  reconciledOriginalLines: ReconciledOriginalLineProjection[];
  authorizedAddedItems: Array<{
    variationId: string;
    lineType: HandymanScopeVariationLineType;
    title: string;
    description: string;
    quantity: string;
    uomId: string;
    status: HandymanScopeVariationStatus;
    qcOutcome: HandymanScopeVariationQcOutcome | null;
    finalChargeEligible: boolean;
    invoiced: boolean;
  }>;
  pendingVariationsCount: number;
  rejectedVariationsCount: number;
  finalChargeEligibleVariationsCount: number;
}

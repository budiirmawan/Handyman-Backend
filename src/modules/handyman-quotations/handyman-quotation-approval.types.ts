/**
 * CR-HM-BE-03 RUN 3 — Customer approval types.
 *
 * The approval belongs to the quotation AND its exact sent revision.
 * APPROVED-FOR (the decision party) and RECORDED-BY (the authenticated staff
 * recorder of an assisted decision) are preserved separately — staff never
 * become the customer merely because they recorded the decision.
 *
 * SECURE_LINK exists in the method vocabulary ONLY (schema/type readiness);
 * it is unreachable through the Run-3 decision runtime and structurally
 * excluded from decided states by the migration-0352 CHECK.
 */

export const HANDYMAN_QUOTATION_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
] as const;
export type HandymanQuotationApprovalStatus =
  (typeof HANDYMAN_QUOTATION_APPROVAL_STATUSES)[number];

export const HANDYMAN_QUOTATION_APPROVAL_METHODS = [
  'IN_APP',
  'ASSISTED',
  'SECURE_LINK',
] as const;
export type HandymanQuotationApprovalMethod =
  (typeof HANDYMAN_QUOTATION_APPROVAL_METHODS)[number];

/** The only decision methods reachable through the Run-3 runtime. */
export const HANDYMAN_QUOTATION_APPROVAL_RUNTIME_METHODS = [
  'IN_APP',
  'ASSISTED',
] as const;
export type HandymanQuotationApprovalRuntimeMethod =
  (typeof HANDYMAN_QUOTATION_APPROVAL_RUNTIME_METHODS)[number];

export const HANDYMAN_QUOTATION_APPROVED_FOR_TYPES = [
  'TENANT_COMPANY',
  'TENANT_PIC',
  'CUSTOMER',
] as const;
export type HandymanQuotationApprovedForType =
  (typeof HANDYMAN_QUOTATION_APPROVED_FOR_TYPES)[number];

export const HANDYMAN_QUOTATION_APPROVAL_DECISIONS = [
  'APPROVED',
  'REJECTED',
] as const;
export type HandymanQuotationApprovalDecision =
  (typeof HANDYMAN_QUOTATION_APPROVAL_DECISIONS)[number];

export const HANDYMAN_QUOTATION_APPROVAL_LINK_STATUSES = [
  'ACTIVE',
  'USED',
  'REVOKED',
  'EXPIRED',
] as const;
export type HandymanQuotationApprovalLinkStatus =
  (typeof HANDYMAN_QUOTATION_APPROVAL_LINK_STATUSES)[number];

export type HandymanQuotationApprovalRecord = {
  id: string;
  quotationId: string;
  quotationRevisionId: string;
  clientId: string;
  buildingId: string;
  status: HandymanQuotationApprovalStatus;
  method: HandymanQuotationApprovalMethod | null;
  approvedForType: HandymanQuotationApprovedForType | null;
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  approvedForName: string | null;
  approvedForCustomerName: string | null;
  approvedForCustomerPhone: string | null;
  approvedForCustomerEmail: string | null;
  decisionNotes: string | null;
  recordedByUserId: string | null;
  decidedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Public shape — never exposes anything token-like; approval rows are the
 * authoritative decision evidence. */
export type PublicHandymanQuotationApproval = {
  id: string;
  quotationId: string;
  quotationRevisionId: string;
  clientId: string;
  buildingId: string;
  status: HandymanQuotationApprovalStatus;
  method: HandymanQuotationApprovalMethod | null;
  approvedForType: HandymanQuotationApprovedForType | null;
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  approvedForName: string | null;
  approvedForCustomerName: string | null;
  approvedForCustomerPhone: string | null;
  approvedForCustomerEmail: string | null;
  decisionNotes: string | null;
  recordedByUserId: string | null;
  decidedAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type HandymanQuotationApprovalLinkRecord = {
  id: string;
  approvalId: string;
  quotationId: string;
  clientId: string;
  buildingId: string;
  tokenHash: string;
  recipientName: string;
  recipientPhone: string | null;
  recipientEmail: string | null;
  status: HandymanQuotationApprovalLinkStatus;
  maxUses: number;
  usesCount: number;
  expiresAt: Date;
  issuedByUserId: string;
  issuedAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Public link shape — token_hash is deliberately ABSENT (hash-only storage
 * must never leak through read surfaces; the raw token exists only in the
 * issuance response, once).
 */
export type PublicHandymanQuotationApprovalLink = {
  id: string;
  approvalId: string;
  quotationId: string;
  status: HandymanQuotationApprovalLinkStatus;
  recipientName: string;
  recipientPhone: string | null;
  recipientEmail: string | null;
  maxUses: number;
  usesCount: number;
  expiresAt: string;
  issuedByUserId: string;
  issuedAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** IN_APP decision input — the caller can NEVER submit approvedFor or
 * recordedBy authority fields; the actor parameter is the only identity. */
export type DecideHandymanQuotationApprovalInAppInput = {
  quotationId: string;
  decision: HandymanQuotationApprovalDecision;
  notes?: string | null;
};

/** ASSISTED decision input — the approved-for party MUST be explicitly
 * identified; recordedBy is always the authenticated actor. */
export type RecordHandymanQuotationApprovalAssistedInput = {
  quotationId: string;
  decision: HandymanQuotationApprovalDecision;
  approvedFor:
    | { type: 'TENANT_COMPANY'; tenantCompanyId: string }
    | { type: 'TENANT_PIC'; tenantPicId: string }
    | { type: 'CUSTOMER' };
  /** Mandatory for assisted decisions (out-of-band evidence trail). */
  notes: string;
};

export type IssueHandymanQuotationApprovalLinkInput = {
  approvalId: string;
  recipientName: string;
  recipientPhone?: string | null;
  recipientEmail?: string | null;
  /** Required; must be in the future at issuance. */
  expiresAt: string;
};

export type IssueHandymanQuotationApprovalLinkResult = {
  /** Returned EXACTLY ONCE at issuance; never stored, never re-readable. */
  rawToken: string;
  link: PublicHandymanQuotationApprovalLink;
};

export type HandymanQuotationApprovalDecisionResult = {
  approval: PublicHandymanQuotationApproval;
  quotation: import('./handyman-quotation.types').PublicHandymanQuotation;
  requestStatus: string;
};

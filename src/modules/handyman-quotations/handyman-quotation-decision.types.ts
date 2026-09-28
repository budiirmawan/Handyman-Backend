/**
 * CR-HM-06 PART 04 — Handyman quotation customer decision types
 * (FROZEN F6/F7/F8). The decision record is an immutable authoritative
 * fact: exactly one per quotation version, bound to the exact ISSUED
 * version presented, replay-safe through the existing idempotency-key/
 * sha256-fingerprint convention. Customer context is a server-derived
 * snapshot of the request lineage (PIC NULL stays NULL — never
 * fabricated). This PART is intermediate runtime: it never creates
 * Execution Scope (PART 05 extends the approval transaction boundary).
 */

export const HANDYMAN_QUOTATION_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type HandymanQuotationDecision =
  (typeof HANDYMAN_QUOTATION_DECISIONS)[number];

/** Full decision database record (immutable). */
export type HandymanQuotationDecisionRecord = {
  id: string;
  clientId: string;
  quotationId: string;
  quotationVersionId: string;
  decision: HandymanQuotationDecision;
  tenantCompanyId: string;
  /** NULL when the authoritative request lineage has no PIC. */
  tenantPicId: string | null;
  decidedByUserId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation. */
export type PublicHandymanQuotationDecision = Omit<
  HandymanQuotationDecisionRecord,
  'decidedAt' | 'createdAt' | 'updatedAt' | 'requestFingerprint'
> & { decidedAt: string; createdAt: string; updatedAt: string };

/**
 * Caller input: the explicit decision + idempotency key ONLY. client /
 * tenant company / PIC / building / actor / version status NEVER enter
 * here (server-derived authority; smuggled keys structurally ignored).
 */
export type DecideHandymanQuotationInput = {
  decision: HandymanQuotationDecision;
  idempotencyKey: string;
};

/** Fully-resolved row ready for persistence. */
export type NewHandymanQuotationDecision = {
  clientId: string;
  quotationId: string;
  quotationVersionId: string;
  decision: HandymanQuotationDecision;
  tenantCompanyId: string;
  tenantPicId: string | null;
  decidedByUserId: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

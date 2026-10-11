/**
 * CR-HM-06 PART 04 — Handyman quotation customer decision types (FROZEN
 * F6/F7/F8). The decision record is an immutable authoritative fact: exactly
 * one per quotation version, bound to the exact ISSUED version presented,
 * replay-safe through the existing idempotency-key/sha256-fingerprint
 * convention. Customer context is a server-derived snapshot of the request
 * lineage (PIC NULL stays NULL — never fabricated).
 *
 * W03 PART 03C (A01 §6.1, `0438`/`0442`) added the actor columns to the table;
 * PART 03E widens these types to match, because 03E is the PART that can
 * actually write a non-`USER` row. Three consequences are load-bearing:
 *
 *   - `decidedByUserId` is **nullable**, not absent: every historical `USER`
 *     row keeps its fact and no consumer has to be retrained to read history
 *     (§6.3). A `TENANT_PIC` row has no user id BY DESIGN (A2) — not a null
 *     placeholder in the client's type either, which is why the actor class
 *     is projected first.
 *   - the actor is a **discriminated union** (C5): a caller cannot express "a
 *     PIC decision" while handing over a user id, nor a staff decision while
 *     omitting one, because each arm carries only its own namespace. The
 *     `USER` arm exists to describe history and to be refused on the write
 *     path (§10.4 S1), which is enforced in the service and again by the DB
 *     guard — never by this type pretending the arm does not exist.
 *   - `tenantPicId` stays what it always was: the **request-lineage snapshot**
 *     copied onto the row (`0394`), and it is never repurposed as "the
 *     approver". The approver is `decidedByTenantPicId`, and it may only be
 *     the PIC the referenced `approvalBindingId` confers (ADD-A R-1.1).
 */

export const HANDYMAN_QUOTATION_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type HandymanQuotationDecision =
  (typeof HANDYMAN_QUOTATION_DECISIONS)[number];

/** Stored actor classes (`0438` CHECK vocabulary, A01 §6.1). */
export const HANDYMAN_QUOTATION_DECISION_ACTOR_TYPES = [
  'USER',
  'TENANT_PIC',
] as const;
export type HandymanQuotationDecisionActorType =
  (typeof HANDYMAN_QUOTATION_DECISION_ACTOR_TYPES)[number];

/**
 * Who is writing this decision. Exactly one arm, and the arm decides which id
 * namespace is populated — the two namespaces are never compared to each other
 * directly (the `0431` rule the ledger CHECK encodes), so a PIC id can never be
 * smuggled into `decided_by_user_id` or vice versa.
 */
export type HandymanQuotationDecisionActor =
  | { kind: 'USER'; userId: string }
  | {
      kind: 'TENANT_PIC';
      /** Must equal the ACTIVE binding's `tenant_pic_id` (R-1.1). */
      tenantPicId: string;
      /** The credential that admitted the signer (A01 §6.1, `0442`). */
      picSessionId: string;
      /** The act of authority this decision stands on (ADD-A §5). */
      approvalBindingId: string;
    };

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
  /** Populated for `USER` rows only; NULL for a PIC row by design (A2). */
  decidedByUserId: string | null;
  decisionActorType: HandymanQuotationDecisionActorType;
  decidedByTenantPicId: string | null;
  decidedByPicSessionId: string | null;
  approvalBindingId: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation. `requestFingerprint` and the replay machinery
 * stay out; actor class is projected before actor ids (§6.3), so a consumer
 * reads "what kind of actor" before it reads "which one".
 */
export type PublicHandymanQuotationDecision = Omit<
  HandymanQuotationDecisionRecord,
  'decidedAt' | 'createdAt' | 'updatedAt' | 'requestFingerprint'
> & { decidedAt: string; createdAt: string; updatedAt: string };

/**
 * Caller input: the explicit decision + idempotency key ONLY. client /
 * tenant company / PIC / building / actor / version status NEVER enter here
 * (server-derived authority; smuggled keys structurally ignored — A01 §4 T1,
 * ADD-A B11). The actor is not part of the body vocabulary either: it is
 * supplied by the authenticated principal, and for a PIC it is assembled from
 * the credential and the thread's own binding, never from the request.
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
  /** Lineage snapshot copied from the request; never the approver. */
  tenantPicId: string | null;
  actor: HandymanQuotationDecisionActor;
  idempotencyKey: string;
  requestFingerprint: string;
};

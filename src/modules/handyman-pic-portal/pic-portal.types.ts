import type { HandymanQuotationAuthorityStatus } from '../handyman-quotation-approval-bindings';

/**
 * W03 PART 03D — the bounded PIC portal read (A01 §9 "portal read", A01 §13
 * `03D`, ADD-A B1–B5 / B12–B17 / C22).
 *
 * Two disciplines govern every type below.
 *
 * 1. MINIMIZATION. A PIC principal is a resolved identity, not a staff member:
 *    no `createdByUserId`, no attribution provenance, no `originChannel`, no
 *    idempotency key or request fingerprint, no occupancy-authority ids, and no
 *    person data of any kind. Every field here exists because the portal needs it
 *    to explain a number or to know why it may not act yet.
 * 2. ELIGIBILITY IS A REPORT, NOT A LEASE (and 03E keeps it that way: the decide
 *    path re-runs this SAME evaluator under its locks rather than trusting a
 *    previous report, and refuses with 409 when the report and the ledger differ). The reason set is computed from the
 *    SAME facts the ledger guard enforces at INSERT, so it predicts the decide
 *    path — it cannot reserve it. Concurrency, a revoke landing after this read,
 *    or an occupancy turnover at decision time all remain the ledger's business
 *    (B16), and `guaranteesDecision` is a literal `false` for exactly that
 *    reason. A client that treats this response as a lock is misusing it.
 */

/** Machine-readable refusal vocabulary. Stable, non-sensitive, no identifiers. */
export const PIC_PORTAL_ELIGIBILITY_CODES = [
  'SESSION_READ_ONLY',
  'NO_ACTIVE_APPROVAL_BINDING',
  'BINDING_WINDOW_LAPSED',
  'BINDING_TARGET_DIFFERS',
  'LINEAGE_PIC_DIFFERS',
  'TENANT_OR_CLIENT_NOT_ACTIVE',
  'OCCUPANCY_NOT_CURRENT',
  'VERSION_NOT_ISSUED',
  'VERSION_VALID_UNTIL_MISSING',
  'VERSION_EXPIRED',
  'ALREADY_DECIDED',
  'MAKER_CHECKER_CONFLICT',
] as const;
export type PicPortalEligibilityCode =
  (typeof PIC_PORTAL_ELIGIBILITY_CODES)[number];

/**
 * Fixed sentences, authored without any identifier, name, e-mail or amount, so
 * serializing the whole block can never leak more than the code itself does
 * (item: non-sensitive reasons only).
 */
export const PIC_PORTAL_ELIGIBILITY_MESSAGES: Record<
  PicPortalEligibilityCode,
  string
> = {
  SESSION_READ_ONLY:
    'This credential was admitted for reading only; it cannot carry a decision.',
  NO_ACTIVE_APPROVAL_BINDING:
    'No approval binding is currently in force for this quotation thread.',
  BINDING_WINDOW_LAPSED:
    'The approval binding in force does not cover this moment.',
  BINDING_TARGET_DIFFERS:
    'The approval binding in force names a different approver.',
  LINEAGE_PIC_DIFFERS:
    'The request lineage names a different approver, and a decision may not replace it.',
  TENANT_OR_CLIENT_NOT_ACTIVE:
    'The tenant or its client is not currently active.',
  OCCUPANCY_NOT_CURRENT:
    'Current occupancy authority for this building does not cover this moment.',
  VERSION_NOT_ISSUED:
    'No issued quotation version is presented for decision at the moment.',
  VERSION_VALID_UNTIL_MISSING:
    'The presented version carries no validity window, so it cannot be decided.',
  VERSION_EXPIRED:
    'The presented version is past its validity window.',
  ALREADY_DECIDED:
    'A decision has already been recorded for the presented version.',
  MAKER_CHECKER_CONFLICT:
    'The prospective approver is on the authoring side of this thread, so self-approval is refused.',
};

export type PublicPicPortalLine = {
  id: string;
  lineType: 'LABOR' | 'MATERIAL';
  description: string;
  quantity: number;
  uomId: string;
  /** The bounded commercial fact being quoted (server-calculated totals aside). */
  finalQuotedUnitAmount: number;
  lineTotal: number;
  currency: string;
};

export type PublicPicPortalTotals = {
  laborSubtotal: number;
  materialSubtotal: number;
  total: number;
  currency: string | null;
  lineCount: number;
};

/** The presented (ISSUED) version only: no revision history, ever. */
export type PublicPicPortalVersion = {
  quotationVersionId: string;
  versionNumber: number;
  status: string;
  validUntil: string | null;
  lines: PublicPicPortalLine[];
  totals: PublicPicPortalTotals;
};

/**
 * The ledger's actor-identity facts, which is what "who signed, under which
 * authority" means after A01. `decidedByUserId` is deliberately absent: a legacy
 * staff row's user id is not a PIC-facing fact (deviation 03D-D4).
 */
export type PublicPicPortalDecision = {
  quotationDecisionId: string;
  decision: 'APPROVE' | 'REJECT';
  decisionActorType: string;
  decidedByTenantPicId: string | null;
  decidedByPicSessionId: string | null;
  approvalBindingId: string | null;
  decidedAt: string;
  /** Whether this very PIC signed it — a boolean, so no other PIC is named. */
  decidedByCaller: boolean;
};

/** A01 §9: ids, status, window and the granter id only. No narrative, no
 * authority-snapshot ids (B17: those are audit evidence, never authority). */
export type PublicPicPortalBinding = {
  approvalBindingId: string;
  status: string;
  tenantPicId: string;
  bindingVersion: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  grantedByUserId: string;
};

export type PublicPicPortalQuotationRead = {
  handymanRequestId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  /** Echoed for context only: request status never gates approval (B7). */
  requestStatus: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  description: string | null;
  quotation: {
    quotationId: string;
    presentedVersion: PublicPicPortalVersion | null;
  } | null;
  decision: PublicPicPortalDecision | null;
  approvalBinding: PublicPicPortalBinding | null;
  session: {
    sessionId: string;
    canDecide: boolean;
    expiresAt: string;
  };
};

export type PublicPicPortalApprovalEligibility = {
  handymanRequestId: string;
  quotationId: string | null;
  quotationVersionId: string | null;
  versionNumber: number | null;
  versionStatus: string | null;
  validUntil: string | null;
  decisionRecorded: boolean;
  /** Whether the thread's lineage PIC agrees with the caller (never an id). */
  lineageMatchesCaller: boolean;
  canDecide: boolean;
  binding: {
    approvalBindingId: string;
    status: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
  } | null;
  eligible: boolean;
  reasons: Array<{
    code: PicPortalEligibilityCode;
    message: string;
  }>;
  evaluatedAt: string;
  /** A literal `false`: this read reports a state, it never reserves an outcome. */
  guaranteesDecision: false;
};

/**
 * W03 PART 03E — the decide surface's body (A01 §9, ADD-A B11).
 *
 * Exactly one key, and it is not a claim about who is deciding: the tenant, the
 * PIC, the session and the binding are all resolved from the credential, so a
 * body that could name them would be a second, weaker path to the same row.
 * Unknown keys are refused by the route's parser before this type is built, and
 * `Idempotency-Key` travels as a header because the key is a property of the
 * attempt, not of the decision.
 */
export type PicPortalDecisionRequestBody = {
  decision: 'APPROVE' | 'REJECT';
};

/**
 * The execution target an APPROVE created, minimized for a PIC (C16).
 *
 * A PIC approved a price for a unit; what it needs back is WHICH version is now
 * locked in and WHERE the work is authorized. So: no `createdByUserId`, no
 * channel attribution, no provenance ids, and — unlike the staff projection — not
 * even the actor class, because the decision block in the same response already
 * says who signed. `tenantCompanyId`/`tenantPicId` stay out too: they are the
 * approval half of the scope (F9), not the operational half, and a PIC read has
 * never been allowed to see them.
 */
export type PublicPicPortalExecutionScope = {
  executionScopeId: string;
  status: string;
  quotationId: string;
  approvedQuotationVersionId: string;
  handymanRequestId: string;
  buildingId: string;
  spaceId: string | null;
  createdAt: string;
};

/** `POST /handyman/pic/quotation-versions/:id/decision` — 201 payload. */
export type PublicPicPortalDecisionWrite = {
  decision: PublicPicPortalDecision;
  /** Non-null on APPROVE only (E5: a REJECT creates nothing). */
  executionScope: PublicPicPortalExecutionScope | null;
};

/** Inputs to the pure evaluator: facts already resolved in the caller's
 * transaction. Nothing here is accepted from a request body — the read surface
 * has no body at all. */
export type PicPortalEligibilityInput = {
  now: Date;
  canDecide: boolean;
  callerPicId: string | null;
  /** `tenant_pics.user_id` of the caller's PIC: the only bridge between the two
   * id namespaces (MC1′), and legitimately NULL (frozen decision 2). */
  callerPicUserId: string | null;
  lineageRequestPicId: string | null;
  tenantStatus: string | null;
  clientStatus: string | null;
  occupancyStatus: HandymanQuotationAuthorityStatus;
  binding: {
    tenantPicId: string;
    grantedByUserId: string;
    effectiveFrom: Date | null;
    effectiveUntil: Date | null;
  } | null;
  version: {
    status: string;
    validUntil: Date | null;
    decisionRecorded: boolean;
    /** M = root author ∪ version author ∪ granter (A01 §8 + MC0). */
    rootAuthorUserId: string;
    versionAuthorUserId: string;
  } | null;
};

/**
 * The refusal set, in a fixed order: credential first, then the authority that
 * confers an approver, then the thread's own state, then maker-checker last
 * (because it is the only one that speaks about a person at all, and it names
 * nobody). An empty array means the decide path would find nothing to refuse on
 * these facts — it does NOT mean a decision is guaranteed.
 *
 * Kept pure and exported so the whole matrix is testable without a database, and
 * so `03E` can reuse the SAME predicate instead of inventing a second one that
 * could disagree with the ledger.
 */
export function evaluatePicApprovalEligibility(
  input: PicPortalEligibilityInput,
): PicPortalEligibilityCode[] {
  const reasons: PicPortalEligibilityCode[] = [];
  const now = input.now.getTime();

  // A read-capable credential carries no PIC identity, so there is nothing for
  // a binding or a lineage to differ FROM. Reporting `BINDING_TARGET_DIFFERS`
  // against a NULL would be a comparison the caller cannot interpret, and a
  // distraction from the real reason: this session cannot decide, full stop
  // (`SESSION_READ_ONLY`). Thread-state reasons are still reported, because
  // they are facts about the quotation rather than about the caller.
  const deciding = input.canDecide && input.callerPicId !== null;
  if (!deciding) {
    reasons.push('SESSION_READ_ONLY');
  }

  const binding = input.binding;
  if (!binding) {
    reasons.push('NO_ACTIVE_APPROVAL_BINDING');
  } else {
    // Mirrors the ledger guard's own predicate exactly:
    // `effective_from <= decided_at AND (effective_until IS NULL OR
    // effective_until > decided_at)`. Reported here against this instant; at
    // decision time the guard re-evaluates against `decided_at`, which is why
    // this read cannot reserve the outcome.
    if (
      (binding.effectiveFrom && binding.effectiveFrom.getTime() > now) ||
      (binding.effectiveUntil !== null &&
        binding.effectiveUntil.getTime() <= now)
    ) {
      reasons.push('BINDING_WINDOW_LAPSED');
    }
    if (deciding && binding.tenantPicId !== input.callerPicId) {
      reasons.push('BINDING_TARGET_DIFFERS');
    }
  }

  if (
    deciding &&
    input.lineageRequestPicId !== null &&
    input.lineageRequestPicId !== input.callerPicId
  ) {
    reasons.push('LINEAGE_PIC_DIFFERS');
  }
  if (input.tenantStatus !== 'ACTIVE' || input.clientStatus !== 'ACTIVE') {
    reasons.push('TENANT_OR_CLIENT_NOT_ACTIVE');
  }
  if (input.occupancyStatus !== 'ACTIVE') {
    reasons.push('OCCUPANCY_NOT_CURRENT');
  }

  if (!input.version) {
    reasons.push('VERSION_NOT_ISSUED');
  } else {
    if (input.version.status !== 'ISSUED') reasons.push('VERSION_NOT_ISSUED');
    if (!input.version.validUntil) {
      reasons.push('VERSION_VALID_UNTIL_MISSING');
    } else if (input.version.validUntil.getTime() <= now) {
      reasons.push('VERSION_EXPIRED');
    }
    if (input.version.decisionRecorded) reasons.push('ALREADY_DECIDED');
    // MC1′ exactly as the ledger evaluates it: the two id namespaces are never
    // compared to each other directly, and an unlinked PIC cannot be refused on
    // a proof that does not exist (that residual is MC4, not a bug here).
    const maker = input.version;
    if (
      deciding &&
      input.callerPicUserId !== null &&
      (input.callerPicUserId === maker.rootAuthorUserId ||
        input.callerPicUserId === maker.versionAuthorUserId ||
        (binding !== null && input.callerPicUserId === binding.grantedByUserId))
    ) {
      reasons.push('MAKER_CHECKER_CONFLICT');
    }
  }

  return reasons;
}

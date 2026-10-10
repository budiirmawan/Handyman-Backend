/**
 * W03 PART 03B2 — Tenant PIC approval-binding authority ledger (ADD-A §3).
 *
 * Types for the append-only binding ledger written by the STAFF surface.
 * The database shape is `0437_handyman_quotation_approval_bindings`; this file
 * never widens it and never re-derives a rule from it.
 *
 * Identity discipline (ADD-A B11, C21, A01 §9): a binding row carries
 * snapshot ids only. NO PIC name, e-mail, phone, role title or any other
 * person-identifying data may enter these types or the public projection —
 * `tenantPicId` is the only PIC reference a caller ever receives, and the
 * snapshot columns are read from (never accepted from) the request lineage.
 */

/** Ledger lifecycle of one binding row. `REVOKED` rows remain as history. */
export const HANDYMAN_QUOTATION_APPROVAL_BINDING_STATUSES = [
  'ACTIVE',
  'REVOKED',
] as const;
export type HandymanQuotationApprovalBindingStatus =
  (typeof HANDYMAN_QUOTATION_APPROVAL_BINDING_STATUSES)[number];

export function isHandymanQuotationApprovalBindingStatus(
  value: unknown,
): value is HandymanQuotationApprovalBindingStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_QUOTATION_APPROVAL_BINDING_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/**
 * LIVE authority state of the occupancy/space row a binding was justified by.
 * Re-resolved per call (B16/B17) — `occupancy_authority_id` is evidence of
 * what justified the binding when it was made, never cached authority.
 */
export const HANDYMAN_QUOTATION_AUTHORITY_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'EXPIRED',
  'MISSING',
  'NOT_APPLICABLE',
] as const;
export type HandymanQuotationAuthorityStatus =
  (typeof HANDYMAN_QUOTATION_AUTHORITY_STATUSES)[number];

/** Full database record (timestamps are `Date` at the repository boundary). */
export type HandymanQuotationApprovalBindingRecord = {
  id: string;
  quotationId: string;
  handymanRequestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  tenantPicId: string;
  bindingVersion: number;
  supersedesBindingId: string | null;
  status: HandymanQuotationApprovalBindingStatus;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  occupancyAuthorityId: string;
  spaceAuthorityId: string | null;
  grantedByUserId: string;
  grantedAt: Date;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Bounded public projection: ids + version + window + revoke facts. No names. */
export type PublicHandymanQuotationApprovalBinding = {
  id: string;
  quotationId: string;
  handymanRequestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  tenantPicId: string;
  bindingVersion: number;
  supersedesBindingId: string | null;
  status: HandymanQuotationApprovalBindingStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  /**
   * Instant the conferred authority actually ends: the stated window end, or
   * the revocation instant when that came first (B16 kills the effect, B14
   * forbids rewriting the row). Server-derived, never caller-set.
   */
  authorityEndsAt: string | null;
  grantedByUserId: string;
  grantedAt: string;
  revokedByUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One row of the bounded history ledger on the read surface. */
export type PublicHandymanQuotationApprovalBindingHistoryEntry = {
  id: string;
  bindingVersion: number;
  status: HandymanQuotationApprovalBindingStatus;
  tenantPicId: string;
  grantedAt: string;
  revokedAt: string | null;
};

/**
 * Live authorization verdict for the thread (item 8). Every field is
 * re-evaluated at read time; `eligibleForApproval` is exactly the conjunction
 * 03C's decision path (C19) will re-check, so the staff surface and the
 * future decision path never disagree about what "eligible" means.
 */
export type PublicHandymanQuotationApprovalStatus = {
  /** `NONE` when the thread has never been bound. */
  bindingStatus: HandymanQuotationApprovalBindingStatus | 'NONE';
  bindingId: string | null;
  bindingVersion: number | null;
  tenantPicId: string | null;
  grantedAt: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  /** B3 basis, LIVE (not the snapshot). */
  occupancyStatus: HandymanQuotationAuthorityStatus;
  /** B4 basis, LIVE; `NOT_APPLICABLE` when the request carries no space. */
  spaceStatus: HandymanQuotationAuthorityStatus;
  /** B1/B2 basis, LIVE: the named PIC still exists, is ACTIVE, same tenant. */
  picStatus: HandymanQuotationAuthorityStatus;
  /** A version is ISSUED and undecided → the binding is pinned (B13). */
  pinned: boolean;
  /** Any decision exists for the thread → frozen forever (B18). */
  frozen: boolean;
  /** The exact live predicate the decision path requires (B16). */
  eligibleForApproval: boolean;
};

export type PublicHandymanQuotationApprovalBindingRead = {
  quotationId: string;
  binding: PublicHandymanQuotationApprovalBinding | null;
  approvalStatus: PublicHandymanQuotationApprovalStatus;
  /** Newest-first, bounded by the repository (max 20 rows), ids only. */
  history: PublicHandymanQuotationApprovalBindingHistoryEntry[];
};

/** Server-derived lineage of the thread a binding is anchored on. */
export type HandymanQuotationBindingLineage = {
  requestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  /** BM-attested lineage PIC (R-1.2 anchor). Never written by this module. */
  requestTenantPicId: string | null;
};

/** The PIC row facts a binding may depend on (no identity fields at all). */
export type HandymanTenantPicBindingFacts = {
  id: string;
  tenantCompanyId: string;
  status: string;
  /** Linked local user, when any — MC1' compares it with the granter. */
  userId: string | null;
};

/** `POST /handyman/quotations/:quotationId/approval-binding` input. */
export type BindHandymanQuotationApprovalBindingInput = {
  quotationId: string;
  tenantPicId: string;
  /** Optional ISO-8601 bound on the conferred window; never defaults. */
  effectiveUntil?: string | null;
  /** Optional operator narrative; audit-only (never a ledger column). */
  note?: string | null;
  /** `Idempotency-Key` header, already normalized by the validator. */
  idempotencyKey: string;
};

/** `POST .../approval-binding/revoke` input. */
export type RevokeHandymanQuotationApprovalBindingInput = {
  quotationId: string;
  /** Required self-describing reason for the revocation (audit-only). */
  reason: string;
  /** Optional stated cutoff; may only TIGHTEN, never extend, authority. */
  effectiveUntil?: string | null;
  idempotencyKey: string;
};

/**
 * Write-surface payload shared by bind and revoke.
 *
 * `replayed` is the CR-BE-IDEMPOTENCY-CORE-01 marker (the response body of the
 * original success, restated — the same convention `handyman-bast-api`
 * exposes). `alreadyBound` / `alreadyRevoked` mark a no-op that restates the
 * current ledger state under a NEW key, which the substrate cannot call a
 * replay because the key differs.
 */
export type HandymanQuotationApprovalBindingWriteData = {
  binding: PublicHandymanQuotationApprovalBinding;
  /** Idempotent replay of an already-recorded act: nothing was written. */
  replayed: boolean;
  /** Bind restated the PIC that already holds the live binding (B14). */
  alreadyBound?: boolean;
  /** Revoke found no live binding and changed nothing. */
  alreadyRevoked?: boolean;
};

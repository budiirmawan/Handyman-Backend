/**
 * CR-HM-06 PART 01 — Handyman quotation foundation types (FROZEN F1–F5
 * in docs/handyman/CR-HM-06_DECISION_FREEZE.md).
 *
 * The quotation ROOT is bound to exactly one CR-HM-02 service request;
 * the VERSION is an immutable commercial-fact container whose PART 01
 * surface carries identity/lifecycle-projection columns ONLY — no labor/
 * material lines, no amounts (PART 02), no lifecycle transitions
 * (PART 03), no approval (PART 04), no execution scope (PART 05), and
 * NO FM/vendor quotation linkage ever.
 */

export const HANDYMAN_QUOTATION_VERSION_STATUSES = [
  'DRAFT',
  'ISSUED',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'SUPERSEDED',
] as const;
export type HandymanQuotationVersionStatus =
  (typeof HANDYMAN_QUOTATION_VERSION_STATUSES)[number];

/** Full quotation root database record. */
export type HandymanQuotationRecord = {
  id: string;
  /** Tenant-isolation root, server-derived from the request. */
  clientId: string;
  /** Parent authority: exactly one CR-HM-02 Handyman service request. */
  handymanRequestId: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Full quotation version database record. */
export type HandymanQuotationVersionRecord = {
  id: string;
  quotationId: string;
  /** Monotonic per quotation; unique pair enforced at the database. */
  versionNumber: number;
  status: HandymanQuotationVersionStatus;
  /** PART 03 expiry handle (PART 01 leaves it NULL). */
  validUntil: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representations (timestamps ISO). */
export type PublicHandymanQuotation = Omit<
  HandymanQuotationRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicHandymanQuotationVersion = Omit<
  HandymanQuotationVersionRecord,
  'validUntil' | 'createdAt' | 'updatedAt'
> & {
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Bounded exact-read bundle: root + its immutable version thread. */
export type PublicHandymanQuotationBundle = {
  quotation: PublicHandymanQuotation;
  versions: PublicHandymanQuotationVersion[];
};

/**
 * Caller input: the request reference ONLY. clientId/customer/building/
 * attribution/diagnosis classification/price facts NEVER enter here
 * (F1/F6: server-derived lineage; smuggled keys are structurally
 * ignored — no runtime spreading of caller objects).
 */
export type CreateHandymanQuotationInput = {
  handymanRequestId: string;
};

/** Fully-resolved rows ready for persistence (server-derived). */
export type NewHandymanQuotation = {
  clientId: string;
  handymanRequestId: string;
  createdByUserId: string;
};

export type NewHandymanQuotationVersion = {
  quotationId: string;
  versionNumber: number;
  status: HandymanQuotationVersionStatus;
  validUntil: Date | null;
  createdByUserId: string;
};

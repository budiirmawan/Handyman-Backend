/**
 * CR-HM-12 PART 04 — BM fee rule definition types ONLY (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §7/§10). One rule per EXACT
 * agreement version; the governed basis vocabulary is exactly the
 * LABOR_ONLY default/reference model. NO percentage, rate, amount,
 * or fee-value fact is representable here — entitlement derivation
 * and any fee VALUE belong to CR-HM-14, computed from governed
 * transactions PLUS this bound rule, never by CR-HM-12. No SaaS
 * subscription/billing state exists in this module's universe (§7/
 * B3/B6).
 */

/** Frozen governed basis vocabulary — extend only by CR, never free text. */
export const HANDYMAN_BM_FEE_RULE_BASES = ['LABOR_ONLY'] as const;

export type HandymanBmFeeRuleBasis =
  (typeof HANDYMAN_BM_FEE_RULE_BASES)[number];

export function isHandymanBmFeeRuleBasis(
  value: string,
): value is HandymanBmFeeRuleBasis {
  return (HANDYMAN_BM_FEE_RULE_BASES as readonly string[]).includes(
    value,
  );
}

/**
 * PART 04 rule-role vocabulary: DEFAULT = the rule CR-HM-14
 * consumes for that exact version; REFERENCE = published reference
 * model, never authoritative for consumption.
 */
export const HANDYMAN_BM_FEE_RULE_MODES = [
  'DEFAULT', 'REFERENCE',
] as const;

export type HandymanBmFeeRuleMode =
  (typeof HANDYMAN_BM_FEE_RULE_MODES)[number];

export function isHandymanBmFeeRuleMode(
  value: string,
): value is HandymanBmFeeRuleMode {
  return (HANDYMAN_BM_FEE_RULE_MODES as readonly string[]).includes(
    value,
  );
}

export type HandymanBmFeeRuleRecord = {
  id: string;
  agreementVersionId: string;
  basis: HandymanBmFeeRuleBasis;
  mode: HandymanBmFeeRuleMode;
  idempotencyKey: string;
  createdByUserId: string;
  createdAt: Date;
};

export type NewHandymanBmFeeRule = {
  agreementVersionId: string;
  basis: HandymanBmFeeRuleBasis;
  mode: HandymanBmFeeRuleMode;
  idempotencyKey: string;
  createdByUserId: string;
};

/* ------------------------------------------------------------------
 * CR-HM-12 PART 06B — the BM fee TERM + BENEFICIARY prerequisite
 * facts (FROZEN `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §4,
 * authorized by `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3).
 *
 * These are the two version-bound inputs the matrix row 21→22
 * precondition required before BM fee entitlement calculation. Both
 * are RULE facts: the numeric term publishes a rate as data and the
 * beneficiary publishes a payee identity — neither computes, applies,
 * or stores a fee VALUE (CR-HM-14's authority), and neither is a
 * charge, ledger row, entitlement, settlement state, or SaaS fact.
 *
 * The rate crosses this boundary as a CANONICAL DECIMAL STRING
 * (`"2.5000"`, exactly 4 decimals) so no float ever touches it; the
 * service validates the (0, 100] bound in integer ten-thousandths.
 * ------------------------------------------------------------------ */

/** Frozen governed term vocabulary — extend only by CR, never free text. */
export const HANDYMAN_BM_FEE_TERM_KINDS = [
  'PERCENTAGE_OF_BASIS',
] as const;

export type HandymanBmFeeTermKind =
  (typeof HANDYMAN_BM_FEE_TERM_KINDS)[number];

export function isHandymanBmFeeTermKind(
  value: string,
): value is HandymanBmFeeTermKind {
  return (HANDYMAN_BM_FEE_TERM_KINDS as readonly string[]).includes(value);
}

/** Canonical decimal shape of `ratePercent` at every boundary. */
export const HANDYMAN_BM_FEE_RATE_SCALE = 4;

export type HandymanBmFeeTermRecord = {
  id: string;
  agreementVersionId: string;
  termKind: HandymanBmFeeTermKind;
  /** Canonical decimal string, exactly 4 decimals (e.g. `"2.5000"`). */
  ratePercent: string;
  idempotencyKey: string;
  createdByUserId: string;
  createdAt: Date;
};

export type NewHandymanBmFeeTerm = {
  agreementVersionId: string;
  termKind: HandymanBmFeeTermKind;
  ratePercent: string;
  idempotencyKey: string;
  createdByUserId: string;
};

/**
 * Frozen governed beneficiary vocabulary. `CLIENT_ORGANIZATION` is
 * the Handyman customer organization bound by the exact agreement
 * version — the reference MUST equal that version's governed
 * `client_id`. No channel-attribution, vendor, caller-supplied, or
 * free-text identity is representable.
 */
export const HANDYMAN_BM_FEE_BENEFICIARY_KINDS = [
  'CLIENT_ORGANIZATION',
] as const;

export type HandymanBmFeeBeneficiaryKind =
  (typeof HANDYMAN_BM_FEE_BENEFICIARY_KINDS)[number];

export function isHandymanBmFeeBeneficiaryKind(
  value: string,
): value is HandymanBmFeeBeneficiaryKind {
  return (HANDYMAN_BM_FEE_BENEFICIARY_KINDS as readonly string[])
    .includes(value);
}

export type HandymanBmFeeBeneficiaryRecord = {
  id: string;
  agreementVersionId: string;
  beneficiaryKind: HandymanBmFeeBeneficiaryKind;
  beneficiaryReferenceId: string;
  idempotencyKey: string;
  createdByUserId: string;
  createdAt: Date;
};

export type NewHandymanBmFeeBeneficiary = {
  agreementVersionId: string;
  beneficiaryKind: HandymanBmFeeBeneficiaryKind;
  beneficiaryReferenceId: string;
  idempotencyKey: string;
  createdByUserId: string;
};

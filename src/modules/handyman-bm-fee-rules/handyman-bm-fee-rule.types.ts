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

export type HandymanTaxTransactionContext = 'CUSTOMER_SERVICE_BILLING' | 'BM_COMMISSION';
/** Internal family codes, not assertions of a particular statutory treatment. */
export type HandymanTaxRuleCode = 'PPN' | 'PPH_WITHHOLDING';
export type HandymanTaxRoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'NO_ROUNDING';

export type HandymanTaxRuleScope = {
  clientId: string;
  transactionContext: HandymanTaxTransactionContext;
  taxCode: HandymanTaxRuleCode;
  /** Explicit, Finance-defined case code; never inferred from a tax identity or PKP status. */
  taxpayerClassification: string;
};
export type CreateHandymanTaxRule = HandymanTaxRuleScope & {
  classificationDescription: string;
  effectiveFrom: string;
  /** Exclusive calendar date, or null for an open-ended rule. */
  effectiveTo: string | null;
  basisMethodCode: string;
  basisDescription: string;
  /** Decimal percentage as a string, not a floating point number or a default. */
  ratePercent: string;
  roundingMode: HandymanTaxRoundingMode;
  roundingScale: number | null;
  legalReference: string;
  legalSource: string;
  evidenceSource: string;
  evidenceReference: string;
  /** Null for the first rule, otherwise the immediately previous version. */
  expectedVersion: number | null;
};
export type HandymanTaxRuleSnapshot = Readonly<{
  schema: 'HANDYMAN_TAX_RULE_V1';
  id: string;
  clientId: string;
  transactionContext: HandymanTaxTransactionContext;
  taxCode: HandymanTaxRuleCode;
  taxpayerClassification: string;
  classificationDescription: string;
  version: number;
  effectiveFrom: string;
  declaredEffectiveTo: string | null;
  basisMethodCode: string;
  basisDescription: string;
  ratePercent: string;
  roundingMode: HandymanTaxRoundingMode;
  roundingScale: number | null;
  legalReference: string;
  legalSource: string;
  evidenceSource: string;
  evidenceReference: string;
  createdByUserId: string;
  createdAt: string;
}>;
export type HandymanTaxRuleView = Readonly<{
  snapshot: HandymanTaxRuleSnapshot;
  digestAlgorithm: 'SHA-256';
  digest: string;
  effectiveWindow: Readonly<{ from: string; to: string | null; closureId: string | null }>;
}>;
export type TaxRuleReviewCommand = {
  clientId: string;
  ruleId: string;
  ruleVersion: number;
  ruleDigest: string;
  evidenceSource: string;
  evidenceReference: string;
};
export type TaxRuleDecisionCommand = TaxRuleReviewCommand & {
  submissionId: string;
  decision: 'APPROVE' | 'REJECT';
  /** Required on approval: the checker attests that the legal source and evidence were verified. */
  sourceValidation: 'FINANCE_VALIDATED' | null;
};
export type TaxRuleApprovalEvent = Readonly<{
  id: string; ruleId: string; clientId: string; ruleVersion: number; ruleDigest: string;
  eventType: 'SUBMIT' | 'APPROVE' | 'REJECT'; submissionId: string | null;
  sourceValidation: 'FINANCE_VALIDATED' | null; actorUserId: string;
  evidenceSource: string; evidenceReference: string; occurredAt: string; reviewFrom: string; reviewTo: string | null;
}>;
export type TaxRuleResolveInput = HandymanTaxRuleScope & {
  /** Indonesian calendar tax date, YYYY-MM-DD. */
  taxDate: string;
  /** Optional past knowledge cutoff; a future cutoff never advances server time. */
  knownAt?: string;
};
export type TaxRuleResolution =
  | Readonly<{ status: 'MISSING' | 'AMBIGUOUS' | 'NOT_APPROVED' | 'INTEGRITY_ERROR' }>
  | Readonly<{ status: 'APPROVED'; rule: HandymanTaxRuleView;
      approval: Readonly<{ submission: TaxRuleApprovalEvent; decision: TaxRuleApprovalEvent }> }>;

import type { PpnIdentityPin, PpnIdentityReference, PpnRulePin } from '../handyman-ppn-calculation';
import type { BmTaxCaseReference } from '../handyman-bm-tax-case';
import type { HandymanTaxRoundingMode, TaxRuleApprovalEvent } from '../handyman-tax-rules';

export type BmWithholdingTreatment = 'WITHHOLD' | 'EXEMPT' | 'NON_WITHHOLD';
export type BmCommissionSource = Readonly<{
  schema: 'HANDYMAN_BM_COMMISSION_SOURCE_V1';
  clientId: string; buildingId: string; executionScopeId: string; transactionId: string;
  entitlementId: string; ledgerContractVersion: 'CR-HM-13-PART-06'; ledgerPostedAt: string; derivedAt: string; derivedByUserId: string;
  currency: 'IDR'; commissionBasis: 'EARNED_BM_COMMISSION'; commissionGross: string;
  laborNet: string; materialNet: string; chargedNet: string; adjustedTransactionScope: string;
  commercialBasis: string; commercialBasisSource: 'LEDGER_LABOR_NET' | 'EXISTING_FISCAL_BASIS';
  commercialFiscalBasis: Readonly<{ tenantProfileId: string; bmProfileId: string }> | null;
  commercialRatePercent: string;
  /** Digest of the sorted, immutable charge and commission-affecting adjustment facts. */
  ledgerBasisDigest: string;
  agreement: Readonly<{ id: string; versionId: string; versionNumber: number; effectiveFrom: string;
    effectiveToAtEarning: string | null; ruleId: string; termId: string; anchorChecksum: string }>;
  beneficiary: Readonly<{ kind: 'BM_LEGAL_COUNTERPARTY' | 'CLIENT_ORGANIZATION'; counterpartyId: string;
    counterpartyChecksum: string; verificationId: string; verificationChecksum: string; verifiedAt: string;
    beneficiaryDefinitionId: string | null; representedClientId: string | null }>;
  coverage: Readonly<{ id: string; effectiveFrom: string; declaredEffectiveTo: string | null;
    effectiveToAtEarning: string | null; immutableChecksum: string }>;
  checksumAlgorithm: 'SHA-256'; checksum: string;
}>;

export type CalculateApprovedBmWithholdingInput = Readonly<{
  clientId: string; entitlementId: string; sourceChecksum: string;
  currency: 'IDR'; commissionBasis: 'EARNED_BM_COMMISSION'; commissionGross: string;
  /** Jakarta calendar day and its actual zoned tax-point instant, both mandatory. */
  taxDate: string; taxPointAt: string;
  treatment: BmWithholdingTreatment;
  /** Explicit Finance-defined 02B case; not inferred from entity, residency or PKP. */
  taxpayerClassification: string;
  beneficiary: PpnIdentityPin;
  rule: PpnRulePin;
}>;

export type ApprovedBmWithholdingBreakdown = Readonly<{
  schema: 'HANDYMAN_BM_PPH_WITHHOLDING_V1';
  clientId: string; taxDate: string; taxPointAt: string; currency: 'IDR';
  commissionBasis: 'EARNED_BM_COMMISSION'; commissionGross: string;
  treatment: BmWithholdingTreatment; taxpayerClassification: string;
  taxableWithholdingBasis: string; ratePercent: string; pphWithheld: string; projectedNetCommission: string;
  rounding: Readonly<{ mode: HandymanTaxRoundingMode; scale: 0 | 2 | null; stages: 'BASIS_THEN_WITHHOLDING' }>;
  basisMethodCode: string;
  source: BmCommissionSource;
  beneficiaryTaxIdentity: PpnIdentityReference;
  rule: Readonly<{ id: string; version: number; digest: string; legalReference: string; legalSource: string;
    classificationDescription: string; basisDescription: string; evidenceSource: string; evidenceReference: string;
    createdByUserId: string; approval: Readonly<{ submission: TaxRuleApprovalEvent; decision: TaxRuleApprovalEvent }> }>;
  /** Rule approval does not itself verify that the Finance case applies to this individual commission. */
  caseApplicability: 'CALLER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED';
  /** This is a projection, never a payable, fiscal document or payout authorization. */
  authority: 'READ_ONLY_PROJECTION';
  checksumAlgorithm: 'SHA-256'; checksum: string;
}>;

/** Existing rule-based result and checksum remain unchanged. */
export type VerifiedBmRuleWithholdingBreakdown = Omit<ApprovedBmWithholdingBreakdown, 'schema' | 'caseApplicability'> & Readonly<{
  schema: 'HANDYMAN_VERIFIED_BM_PPH_WITHHOLDING_V1';
  caseApplicability: 'INDEPENDENTLY_FINANCE_APPROVED';
  determination: BmTaxCaseReference;
}>;
/** No rule, rate, tax basis or rounding is asserted for independently reviewed non-applicability. */
export type VerifiedBmNonApplicableWithholdingBreakdown = Readonly<{
  schema: 'HANDYMAN_VERIFIED_BM_PPH_NOT_APPLICABLE_V1'; clientId: string; taxDate: string; taxPointAt: string; currency: 'IDR';
  commissionBasis: 'EARNED_BM_COMMISSION'; commissionGross: string; treatment: 'NOT_APPLICABLE'; taxpayerClassification: null;
  taxableWithholdingBasis: null; ratePercent: null; pphWithheld: '0.00'; projectedNetCommission: string;
  rounding: null; basisMethodCode: null; rule: null; source: BmCommissionSource; beneficiaryTaxIdentity: PpnIdentityReference;
  nonApplicability: import('../handyman-bm-tax-case').BmNonApplicabilityProvenance;
  caseApplicability: 'INDEPENDENTLY_FINANCE_APPROVED'; authority: 'READ_ONLY_PROJECTION'; determination: BmTaxCaseReference;
  checksumAlgorithm: 'SHA-256'; checksum: string;
}>;
export type VerifiedBmWithholdingBreakdown = VerifiedBmRuleWithholdingBreakdown | VerifiedBmNonApplicableWithholdingBreakdown;

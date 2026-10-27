import type { BuyerBindingPin } from '../handyman-buyer-binding';
import type { HandymanTaxIdentityOwner, TaxIdentityApprovalEvent } from '../handyman-tax-identity';
import type { HandymanTaxRoundingMode, HandymanTaxTransactionContext, TaxRuleApprovalEvent } from '../handyman-tax-rules';

export type PpnApplicability = 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';
export type PpnIdentityPin = Readonly<{
  owner: HandymanTaxIdentityOwner;
  profileId: string;
  profileVersion: number;
  profileDigest: string;
  approvalDecisionId: string;
}>;
export type PpnRulePin = Readonly<{
  ruleId: string;
  ruleVersion: number;
  ruleDigest: string;
  approvalDecisionId: string;
}>;
export type CalculateApprovedPpnInput = Readonly<{
  clientId: string;
  /** Legacy customer requests remain blocked; use CalculateCustomerPpnInput for the verified-buyer boundary. */
  transactionContext: HandymanTaxTransactionContext;
  /** Explicit Indonesian calendar tax date and its actual zoned tax-point instant. */
  taxDate: string;
  taxPointAt: string;
  currency: 'IDR';
  amountBasis: 'PPN_EXCLUSIVE';
  /** Nonnegative canonical NUMERIC(18,2) string; IDR's minor-unit precision is zero. */
  sourceAmount: string;
  applicability: PpnApplicability;
  /** Explicit approved 0497 classification; never inferred from PKP alone. */
  taxpayerClassification: string;
  supplier: PpnIdentityPin;
  recipient: PpnIdentityPin;
  rule: PpnRulePin;
}>;
/** Customer context can now name a verified request buyer without impersonating a BM.
 * Calculation remains blocked until a separately governed buyer tax identity exists. */
export type CalculateCustomerPpnInput = Omit<CalculateApprovedPpnInput, 'transactionContext' | 'recipient'> & Readonly<{
  transactionContext: 'CUSTOMER_SERVICE_BILLING'; requestId: string; buyer: BuyerBindingPin;
}>;
export type PpnIdentityReference = Readonly<{
  ownerKind: HandymanTaxIdentityOwner['kind']; ownerId: string; clientId: string;
  profileId: string; profileVersion: number; profileDigest: string;
  issuerProfileId: string | null; counterpartyId: string | null; verificationId: string | null;
  evidenceSource: string; evidenceReference: string; createdByUserId: string;
  taxpayerKind: 'LEGAL_ENTITY' | 'INDIVIDUAL'; individualResidency: 'RESIDENT' | 'NON_RESIDENT' | null;
  pkpStatus: 'PKP' | 'NON_PKP';
  approval: Readonly<{ submission: TaxIdentityApprovalEvent; decision: TaxIdentityApprovalEvent }>;
}>;
export type ApprovedPpnBreakdown = Readonly<{
  schema: 'HANDYMAN_PPN_CALCULATION_V1';
  clientId: string; transactionContext: HandymanTaxTransactionContext; taxDate: string; taxPointAt: string;
  currency: 'IDR'; amountBasis: 'PPN_EXCLUSIVE'; applicability: PpnApplicability; taxpayerClassification: string;
  sourceAmount: string; dppAmount: string; ppnRatePercent: string; ppnAmount: string; totalIncludingPpn: string;
  rounding: Readonly<{ mode: HandymanTaxRoundingMode; scale: 0 | null; stages: 'DPP_THEN_PPN' }>;
  basisMethodCode: string;
  rule: Readonly<{ id: string; version: number; digest: string; legalReference: string; legalSource: string;
    classificationDescription: string; basisDescription: string; evidenceSource: string; evidenceReference: string;
    createdByUserId: string; approval: Readonly<{ submission: TaxRuleApprovalEvent; decision: TaxRuleApprovalEvent }> }>;
  supplier: PpnIdentityReference; recipient: PpnIdentityReference;
  /** No invoice, contract, tenant-company or Building beneficiary binding is asserted by this pure calculation. */
  transactionPartyBinding: 'CALLER_SUPPLIED_NOT_VERIFIED';
  checksumAlgorithm: 'SHA-256'; checksum: string;
}>;

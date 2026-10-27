import type { BuyerBindingPin } from '../handyman-buyer-binding';

export type CustomerDocumentClass = 'ORDINARY' | 'FINAL_CONSUMER';
export type CustomerIdentifierKind = 'NPWP_15' | 'NPWP_16' | 'NIK_16' | 'NIK_NPWP_16' | 'PASSPORT' | 'NONE';
export type CustomerTaxRulePin = Readonly<{ ruleId: string; ruleVersion: number; ruleDigest: string; approvalDecisionId: string }>;
export type CustomerTaxClassificationPin = Readonly<{
  classificationId: string; version: number; digest: string; decisionId: string; decisionDigest: string;
}>;
export type RetailEvidence = Readonly<{
  sellerEligible: boolean; directRetail: boolean; finalConsumption: boolean; forResale: boolean; evidenceReferenceId: string;
}>;
export type ProposeCustomerTaxClassification = Readonly<{
  clientId: string; requestId: string; buyer: BuyerBindingPin; rule: CustomerTaxRulePin;
  taxpayerClassification: string; applicability: 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';
  taxDate: string; taxPointAt: string; currency: 'IDR'; amountBasis: 'PPN_EXCLUSIVE'; sourceAmount: string;
  identifierKind: CustomerIdentifierKind; identifierReferenceId: string | null;
  retail: RetailEvidence | null; transactionEvidenceReferenceId: string;
  /** Reviewed assertion that the supplier and buyer are not the same taxpayer. */
  distinctFromSupplier: boolean;
  expectedVersion: number | null;
}>;
/** Scalar-only immutable assertion; no taxpayer number, scan or raw identity document is stored. */
export type CustomerTaxSnapshot = Readonly<{
  schema: 'HANDYMAN_CUSTOMER_TAX_V1'; id: string; version: number; previousClassificationId: string | null;
  clientId: string; buildingId: string; requestId: string; buyerTenantCompanyId: string;
  buyerKind: 'INDIVIDUAL' | 'LEGAL_ENTITY';
  buyerBindingId: string; buyerBindingVersion: number; buyerBindingDigest: string; buyerDecisionId: string; buyerDecisionDigest: string;
  ruleId: string; ruleVersion: number; ruleDigest: string; ruleDecisionId: string;
  taxpayerClassification: string; applicability: 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';
  taxDate: string; taxPointAt: string; currency: 'IDR'; amountBasis: 'PPN_EXCLUSIVE'; sourceAmount: string; documentClass: CustomerDocumentClass;
  identifierKind: CustomerIdentifierKind; identifierReferenceId: string | null;
  retailSellerEligible: boolean | null; retailDirect: boolean | null; retailFinalConsumption: boolean | null; retailForResale: boolean | null;
  retailEvidenceReferenceId: string | null; transactionEvidenceReferenceId: string;
  distinctFromSupplier: true; createdByUserId: string;
}>;
export type CustomerTaxView = Readonly<{ snapshot: CustomerTaxSnapshot; digest: string; digestAlgorithm: 'SHA-256'; createdAt: string }>;
export type DecideCustomerTaxClassification = Readonly<{
  clientId: string; requestId: string; classificationId: string; version: number; digest: string;
  decision: 'VERIFY' | 'REJECT'; evidenceReferenceId: string;
}>;
export type CustomerTaxDecision = Readonly<{
  id: string; classificationId: string; clientId: string; buildingId: string; requestId: string;
  version: number; classificationDigest: string; decision: 'VERIFY' | 'REJECT';
  evidenceReferenceId: string; actorUserId: string; occurredAt: string; decisionDigest: string;
}>;
export type VerifiedCustomerTaxClassification = Readonly<{ classification: CustomerTaxView; decision: CustomerTaxDecision }>;

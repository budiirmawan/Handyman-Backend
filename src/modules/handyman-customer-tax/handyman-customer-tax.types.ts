import type { BuyerBindingPin } from '../handyman-buyer-binding';
import type { PpnIdentityPin } from '../handyman-ppn-calculation';
import type { InclusiveCommercialSource } from './handyman-inclusive-source';

export type CustomerDocumentClass = 'ORDINARY' | 'FINAL_CONSUMER';
export type CustomerIdentifierKind = 'NPWP_15' | 'NPWP_16' | 'NIK_16' | 'NIK_NPWP_16' | 'PASSPORT' | 'NONE';
export type CustomerTaxRulePin = Readonly<{ ruleId: string; ruleVersion: number; ruleDigest: string; approvalDecisionId: string }>;
export type CustomerTaxClassificationPin = Readonly<{
  classificationId: string; version: number; digest: string; decisionId: string; decisionDigest: string;
}>;
export type RetailEvidence = Readonly<{
  sellerEligible: boolean; directRetail: boolean; finalConsumption: boolean; forResale: boolean; evidenceReferenceId: string;
}>;
/** Each line is individually reviewed; rule and evidence are never inferred from another line. */
export type InclusiveLineTreatment = Readonly<{
  chargeLineId: string; taxpayerClassification: string; rule: CustomerTaxRulePin; evidenceReferenceId: string;
}>;
export type InclusiveInvoiceProposal = Readonly<{
  executionScopeId: string; supplier: PpnIdentityPin; lines: ReadonlyArray<InclusiveLineTreatment>;
}>;
export type InclusiveInvoiceClassification = InclusiveInvoiceProposal & Readonly<{ source: InclusiveCommercialSource }>;
export type ProposeCustomerTaxClassification = Readonly<{
  clientId: string; requestId: string; buyer: BuyerBindingPin; rule: CustomerTaxRulePin;
  taxpayerClassification: string; applicability: 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';
  taxDate: string; taxPointAt: string; currency: 'IDR'; amountBasis: 'PPN_EXCLUSIVE' | 'PPN_INCLUSIVE'; sourceAmount: string;
  /** Required only for an inclusive, individually classified invoice source. */
  invoice?: InclusiveInvoiceProposal;
  identifierKind: CustomerIdentifierKind; identifierReferenceId: string | null;
  retail: RetailEvidence | null; transactionEvidenceReferenceId: string;
  /** Reviewed assertion that the supplier and buyer are not the same taxpayer. */
  distinctFromSupplier: boolean;
  expectedVersion: number | null;
}>;
/** No taxpayer number, scan or raw identity document is stored. V2 contains separately reviewed line treatments. */
export type CustomerTaxSnapshot = Readonly<{
  schema: 'HANDYMAN_CUSTOMER_TAX_V1' | 'HANDYMAN_CUSTOMER_TAX_V2'; id: string; version: number; previousClassificationId: string | null;
  clientId: string; buildingId: string; requestId: string; buyerTenantCompanyId: string;
  buyerKind: 'INDIVIDUAL' | 'LEGAL_ENTITY';
  buyerBindingId: string; buyerBindingVersion: number; buyerBindingDigest: string; buyerDecisionId: string; buyerDecisionDigest: string;
  ruleId: string; ruleVersion: number; ruleDigest: string; ruleDecisionId: string;
  taxpayerClassification: string; applicability: 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';
  taxDate: string; taxPointAt: string; currency: 'IDR'; amountBasis: 'PPN_EXCLUSIVE' | 'PPN_INCLUSIVE'; sourceAmount: string; documentClass: CustomerDocumentClass;
  invoice?: InclusiveInvoiceClassification;
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

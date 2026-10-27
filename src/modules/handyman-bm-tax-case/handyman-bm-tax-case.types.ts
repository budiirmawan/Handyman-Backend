import type { PpnApplicability, PpnIdentityPin, PpnRulePin } from '../handyman-ppn-calculation';
import type { BmWithholdingTreatment } from '../handyman-pph-calculation';

export type BmTaxCasePin = Readonly<{ caseId: string; version: number; digest: string; decisionId: string; decisionDigest: string }>;
export type BmPpnCaseInput = Readonly<{
  taxDate: string; taxPointAt: string; amountBasis: 'PPN_EXCLUSIVE'; applicability: PpnApplicability;
  taxpayerClassification: string; supplier: PpnIdentityPin; recipient: PpnIdentityPin; rule: PpnRulePin;
  evidenceReferenceId: string;
}>;
export type BmPphCaseInput = Readonly<{
  taxDate: string; taxPointAt: string; treatment: BmWithholdingTreatment;
  taxpayerClassification: string; beneficiary: PpnIdentityPin; rule: PpnRulePin; evidenceReferenceId: string;
}>;
export type ProposeBmTaxCaseInput = Readonly<{
  clientId: string; entitlementId: string; sourceChecksum: string;
  transactionClassification: string; serviceClassification: string; transactionEvidenceReferenceId: string;
  ppn: BmPpnCaseInput; pph: BmPphCaseInput;
  expectedVersion: number | null; idempotencyKey: string;
}>;
/** Scalar-only assertion. It contains no taxpayer number or uploaded evidence. */
export type BmTaxCaseSnapshot = Readonly<{
  schema: 'HANDYMAN_BM_TAX_CASE_V1'; id: string; version: number; previousCaseId: string | null;
  clientId: string; buildingId: string; entitlementId: string; executionScopeId: string; transactionId: string;
  sourceChecksum: string; commissionGross: string; currency: 'IDR'; commissionBasis: 'EARNED_BM_COMMISSION';
  counterpartyId: string; verificationId: string; coverageId: string; agreementId: string; agreementVersionId: string;
  agreementVersionNumber: number;
  transactionClassification: string; serviceClassification: string; transactionEvidenceReferenceId: string;
  ppnTaxDate: string; ppnTaxPointAt: string; ppnAmountBasis: 'PPN_EXCLUSIVE'; ppnApplicability: PpnApplicability;
  ppnTaxpayerClassification: string; ppnEvidenceReferenceId: string;
  ppnRuleId: string; ppnRuleVersion: number; ppnRuleDigest: string; ppnRuleDecisionId: string;
  ppnBeneficiaryProfileId: string; ppnBeneficiaryVersion: number; ppnBeneficiaryDigest: string; ppnBeneficiaryDecisionId: string;
  ppnIssuerProfileId: string; ppnIssuerVersion: number; ppnIssuerDigest: string; ppnIssuerDecisionId: string;
  pphTaxDate: string; pphTaxPointAt: string; pphTreatment: BmWithholdingTreatment;
  pphTaxpayerClassification: string; pphEvidenceReferenceId: string;
  pphRuleId: string; pphRuleVersion: number; pphRuleDigest: string; pphRuleDecisionId: string;
  pphBeneficiaryProfileId: string; pphBeneficiaryVersion: number; pphBeneficiaryDigest: string; pphBeneficiaryDecisionId: string;
  createdByUserId: string; idempotencyKey: string; intentDigest: string;
}>;
export type BmTaxCaseView = Readonly<{ snapshot: BmTaxCaseSnapshot; digestAlgorithm: 'SHA-256'; digest: string; createdAt: string; replayed: boolean }>;
export type DecideBmTaxCaseInput = Readonly<{
  clientId: string; entitlementId: string; caseId: string; version: number; digest: string; decision: 'APPROVE' | 'REJECT';
  ppnReviewEvidenceReferenceId: string; pphReviewEvidenceReferenceId: string;
}>;
export type BmTaxCaseDecision = Readonly<{
  id: string; caseId: string; clientId: string; buildingId: string; entitlementId: string; version: number; caseDigest: string;
  decision: 'APPROVE' | 'REJECT'; ppnReviewEvidenceReferenceId: string; pphReviewEvidenceReferenceId: string;
  actorUserId: string; occurredAt: string; decisionDigest: string; replayed: boolean;
}>;
export type BmTaxCaseReference = Readonly<{
  caseId: string; version: number; digest: string; decisionId: string; decisionDigest: string;
  actorUserId: string; occurredAt: string; transactionClassification: string; serviceClassification: string;
}>;
export type BmVerifiedCalculationInput = Readonly<{ clientId: string; entitlementId: string; determination: BmTaxCasePin }>;

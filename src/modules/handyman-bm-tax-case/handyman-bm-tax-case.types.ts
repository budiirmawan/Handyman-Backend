import type { PpnApplicability, PpnIdentityPin, PpnRulePin } from '../handyman-ppn-calculation';
import type { BmWithholdingTreatment } from '../handyman-pph-calculation';

export type BmTaxCasePin = Readonly<{ caseId: string; version: number; digest: string; decisionId: string; decisionDigest: string }>;
export type BmPpnCaseInput = Readonly<{
  taxDate: string; taxPointAt: string; amountBasis: 'PPN_EXCLUSIVE';
  supplier: PpnIdentityPin; recipient: PpnIdentityPin; evidenceReferenceId: string;
}> & (Readonly<{ applicability: PpnApplicability; taxpayerClassification: string; rule: PpnRulePin }> |
  Readonly<{ applicability: 'NOT_APPLICABLE'; legalReference: string; legalSource: string }>);
export type BmPphCaseInput = Readonly<{
  taxDate: string; taxPointAt: string; beneficiary: PpnIdentityPin; evidenceReferenceId: string;
}> & (Readonly<{ treatment: BmWithholdingTreatment; taxpayerClassification: string; rule: PpnRulePin }> |
  Readonly<{ treatment: 'NOT_APPLICABLE'; legalReference: string; legalSource: string }>);
export type ProposeBmTaxCaseInput = Readonly<{
  clientId: string; entitlementId: string; sourceChecksum: string;
  transactionClassification: string; serviceClassification: string; transactionEvidenceReferenceId: string;
  ppn: BmPpnCaseInput; pph: BmPphCaseInput;
  expectedVersion: number | null; idempotencyKey: string;
}>;
/** Original scalar-only 0500 assertion, preserved byte-for-byte for existing cases. */
export type BmTaxCaseSnapshotV1 = Readonly<{
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
/** V2 is used only when a tax is explicitly NOT_APPLICABLE; its rule and classification are null. */
export type BmTaxCaseSnapshotV2 = Omit<BmTaxCaseSnapshotV1,
  'schema'|'ppnApplicability'|'ppnTaxpayerClassification'|'ppnRuleId'|'ppnRuleVersion'|'ppnRuleDigest'|'ppnRuleDecisionId'|
  'pphTreatment'|'pphTaxpayerClassification'|'pphRuleId'|'pphRuleVersion'|'pphRuleDigest'|'pphRuleDecisionId'> & Readonly<{
  schema: 'HANDYMAN_BM_TAX_CASE_V2';
  ppnApplicability: PpnApplicability | 'NOT_APPLICABLE'; ppnTaxpayerClassification: string | null;
  ppnRuleId: string | null; ppnRuleVersion: number | null; ppnRuleDigest: string | null; ppnRuleDecisionId: string | null;
  pphTreatment: BmWithholdingTreatment | 'NOT_APPLICABLE'; pphTaxpayerClassification: string | null;
  pphRuleId: string | null; pphRuleVersion: number | null; pphRuleDigest: string | null; pphRuleDecisionId: string | null;
  ppnLegalReference: string | null; ppnLegalSource: string | null; pphLegalReference: string | null; pphLegalSource: string | null;
}>;
export type BmTaxCaseSnapshot = BmTaxCaseSnapshotV1 | BmTaxCaseSnapshotV2;
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
/** Explicitly reviewed legal assertion, never a zero-rate rule or an inferred exemption. */
export type BmNonApplicabilityProvenance = Readonly<{
  legalReference: string; legalSource: string; evidenceReferenceId: string; reviewEvidenceReferenceId: string;
  makerUserId: string; checkerUserId: string;
}>;
export type BmVerifiedCalculationInput = Readonly<{ clientId: string; entitlementId: string; determination: BmTaxCasePin }>;

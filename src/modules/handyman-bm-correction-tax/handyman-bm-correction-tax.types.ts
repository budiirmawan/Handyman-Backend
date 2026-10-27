import type { BmTaxCasePin, BmTaxCaseSnapshotV2, ProposeBmTaxCaseInput } from '../handyman-bm-tax-case';
import type { BmOriginalCommissionAnchor } from '../handyman-pph-calculation/handyman-pph.types';

/** One recorded 0417 fact, not an inferred commission from a refund or quote. */
export type BmCorrectedCommissionSource = Readonly<{
  schema: 'HANDYMAN_BM_CORRECTED_COMMISSION_SOURCE_V1';
  clientId: string; buildingId: string; executionScopeId: string; transactionId: string; entitlementId: string;
  ledgerPostedAt: string; currency: 'IDR'; commissionBasis: 'CORRECTED_BM_COMMISSION'; commissionGross: string;
  beneficiary: BmOriginalCommissionAnchor['beneficiary']; coverage: BmOriginalCommissionAnchor['coverage'];
  agreement: BmOriginalCommissionAnchor['agreement']; originalCommissionGross: string; originalAnchorChecksum: string;
  originalSourceChecksum: string; baseline: BmTaxCasePin;
  correctionFactId: string; correctionFactChecksum: string; ledgerCorrectionId: string; signedAmount: string;
  lineageChecksum: string; checksumAlgorithm: 'SHA-256'; checksum: string;
}>;

export type ReadBmCorrectionSourceInput = Readonly<{
  clientId: string; entitlementId: string; correctionFactId: string; baseline: BmTaxCasePin;
}>;
/** The maker must separately provide both correction-specific tax points and evidence. */
export type ProposeBmCorrectionTaxInput = ProposeBmTaxCaseInput & Readonly<{
  correctionFactId: string; baseline: BmTaxCasePin;
}>;
export type BmCorrectionTaxSnapshot = Omit<BmTaxCaseSnapshotV2,'schema'|'commissionBasis'> & Readonly<{
  schema: 'HANDYMAN_BM_CORRECTION_TAX_CASE_V1'; commissionBasis: 'CORRECTED_BM_COMMISSION';
  correctionFactId: string; correctionFactChecksum: string; ledgerCorrectionId: string; signedAmount: string;
  originalCommissionGross: string; originalAnchorChecksum: string; originalSourceChecksum: string; lineageChecksum: string;
  baselineCaseId: string; baselineCaseVersion: number; baselineCaseDigest: string; baselineDecisionId: string; baselineDecisionDigest: string;
  intent: ProposeBmTaxCaseInput;
}>;
export type BmCorrectionTaxView = Readonly<{
  snapshot: BmCorrectionTaxSnapshot; digestAlgorithm: 'SHA-256'; digest: string; createdAt: string; replayed: boolean;
}>;
export type DecideBmCorrectionTaxInput = Readonly<{
  clientId: string; entitlementId: string; correctionFactId: string; caseId: string; version: number; digest: string;
  decision: 'APPROVE'|'REJECT'; ppnReviewEvidenceReferenceId: string; pphReviewEvidenceReferenceId: string;
}>;
export type BmCorrectionTaxDecision = Readonly<{
  id: string; caseId: string; clientId: string; buildingId: string; entitlementId: string; correctionFactId: string;
  version: number; caseDigest: string; decision: 'APPROVE'|'REJECT'; ppnReviewEvidenceReferenceId: string;
  pphReviewEvidenceReferenceId: string; actorUserId: string; occurredAt: string; decisionDigest: string; replayed: boolean;
}>;
export type BmCorrectionTaxProjectionInput = Readonly<{
  clientId: string; entitlementId: string; correctionFactId: string; determination: BmTaxCasePin;
}>;

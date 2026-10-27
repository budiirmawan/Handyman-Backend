import type { BmOriginalCommissionAnchor } from '../handyman-pph-calculation/handyman-pph.types';

/** A legacy fact is not promoted into a newly verified legal counterparty. */
export type LegacyBmEarnedAnchor = Readonly<{
  schema: 'HANDYMAN_BM_LEGACY_EARNED_ANCHOR_V1';
  clientId: string; buildingId: string; executionScopeId: string; transactionId: string;
  entitlementId: string; ledgerContractVersion: 'CR-HM-13-PART-06';
  ledgerPostedAt: string; derivedAt: string; derivedByUserId: string;
  currency: 'IDR'; commissionBasis: 'EARNED_BM_COMMISSION'; commissionGross: string;
  laborNet: string; materialNet: string; chargedNet: string; adjustedTransactionScope: string;
  commercialBasis: string; commercialBasisSource: 'LEDGER_LABOR_NET' | 'EXISTING_FISCAL_BASIS';
  commercialFiscalBasis: Readonly<{ tenantProfileId: string; bmProfileId: string }> | null;
  commercialRatePercent: string;
  agreement: Readonly<{ id: string; versionId: string; versionNumber: number;
    effectiveFrom: string; effectiveToAtEarning: string | null; ruleId: string; termId: string }>;
  beneficiary: Readonly<{ kind: 'CLIENT_ORGANIZATION'; beneficiaryDefinitionId: string;
    representedClientId: string; counterpartyId: null; verificationId: null }>;
  coverage: null; checksumAlgorithm: 'SHA-256'; checksum: string;
}>;

export type BmLineageOriginal = Readonly<{
  bindingStatus: 'VERIFIED_HISTORICAL_BINDING' | 'LEGACY_COVERAGE_UNRESOLVED';
  anchor: BmOriginalCommissionAnchor | LegacyBmEarnedAnchor;
  requestId: string;
}>;

export type BmLineageBlocker = Readonly<{ code: string; sourceId: string }>;
export type BmLineageVariation = Readonly<{
  variationId: string; kind: 'ADD' | 'REDUCE'; lineKind: 'LABOR' | 'MATERIAL';
  variationVersion: number; revisedQuotationVersionId: string; revisedQuotationVersionNumber: number;
  targetQuotationLineId: string | null; currency: string;
  /** The approved quote is not a posted charge or a commission delta. */
  authorizedQuoteDelta: string; relationToEarning: 'UNKNOWN';
  lifecycleEvents: ReadonlyArray<Readonly<{ id: string; type: string; actorUserId: string;
    actorRole: string; occurredAt: string; evidenceReference: string }>>;
  qcRunId: string; bastId: string;
  candidateChargeLineIds: readonly string[]; candidateLedgerCorrectionIds: readonly string[];
  financialLink: 'UNPROVEN'; commissionImpact: null;
}>;

export type BmLineageCharge = Readonly<{
  chargeLineId: string; transactionEventId: string; basisId: string;
  quotationLineId: string; quotationVersionId: string; quotationVersionNumber: number;
  /** The composition anchor may instead retain the transaction's original quotation version. */
  basisQuotationVersionId: string;
  lineKind: 'LABOR' | 'MATERIAL'; currency: string;
  /** Posted charge only; it is not an attributed variation or commission delta. */
  signedPostedCharge: string; relationToEarning: 'UNKNOWN';
  candidateVariationIds: readonly string[];
}>;

export type BmLineageEntitlementCorrection = Readonly<{
  id: string; factKind: 'ADJUSTED_INCREASE' | 'ADJUSTED_DECREASE' | 'REVERSED';
  recordedAmount: string; actorUserId: string; occurredAt: string;
  idempotencyKey: string; sourceVersion: 'CR-HM-14-PART-02';
  /** Only the explicit, validated 0417 fact; never an inferred tax or net calculation. */
  signedRecordedCommissionImpact: string | null;
  status: 'RECORDED_LINKED_FACT' | 'UNRESOLVED'; reasons: readonly string[];
}>;

export type BmLineageLedgerCorrection = Readonly<{
  id: string; kind: 'REFUND' | 'REVERSAL' | 'ADJUSTMENT';
  sourceKind: 'PAYMENT' | 'ALLOCATION' | 'CHARGE_LINE' | 'TRANSACTION';
  sourcePaymentId: string | null; sourceAllocationId: string | null;
  /** Confirmation event of the source payment, including an allocation's payment. */
  paymentConfirmationEventId: string | null;
  sourceChargeLineId: string | null; sourceLineKind: 'LABOR' | 'MATERIAL' | null;
  currency: string; amount: string; reason: string; actorUserId: string;
  idempotencyKey: string; occurredAt: string; createdAt: string;
  sourceVersion: 'CR-HM-13-PART-06'; relationToEarning: 'UNKNOWN';
  /** Cash refund, payment-record reversal, unapplication, or charge reduction: separate dimensions. */
  ledgerImpact: Readonly<{ dimension: 'CUSTOMER_REFUND' | 'PAYMENT_RECORD_REVERSAL' |
    'ALLOCATION_UNAPPLICATION' | 'CHARGE_REDUCTION'; signedAmount: string }> | null;
  entitlementCorrection: BmLineageEntitlementCorrection | null;
  status: 'RECORDED_LEDGER_FACT' | 'UNRESOLVED'; reasons: readonly string[];
}>;

export type BmCommissionCorrectionLineage = Readonly<{
  schema: 'HANDYMAN_BM_COMMISSION_CORRECTION_LINEAGE_V1'; authority: 'READ_ONLY_LINEAGE';
  original: BmLineageOriginal;
  variations: readonly BmLineageVariation[];
  candidateCharges: readonly BmLineageCharge[];
  ledgerCorrections: readonly BmLineageLedgerCorrection[];
  unlinkedEntitlementCorrections: ReadonlyArray<BmLineageEntitlementCorrection & Readonly<{ ledgerCorrectionId: string }>>;
  blockers: readonly BmLineageBlocker[];
  resolution: 'NO_CORRECTIONS_OBSERVED' | 'UNRESOLVED';
  /** No combined delta, corrected earning, tax, settlement, payable, or posting authority is supplied. */
  correctedCommission: null; correctedTaxCalculation: 'UNSUPPORTED';
  historicalTaxCase: 'UNCHANGED'; historicalSettlement: 'UNCHANGED';
  checksumAlgorithm: 'SHA-256'; checksum: string;
}>;

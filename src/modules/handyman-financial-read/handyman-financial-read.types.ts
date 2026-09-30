import type {
  HandymanLedgerReadAuthority,
  ReadHandymanLedgerClientBasisOptions,
} from '../handyman-customer-ledger-read';

/** Read-only PART 04 contract, not a new eligibility or money authority. */
export const HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION = 'CR-HM-14-PART-04' as const;
export const HANDYMAN_FINANCIAL_READ_STATUSES = [
  'LEDGER_NOT_AUTHORITATIVE', 'ENTITLEMENT_FACTS_MISSING',
  'EARNED', 'PAYABLE', 'INCLUDED_IN_SETTLEMENT', 'SETTLED',
  'EXCEPTION_RECORDED', 'RECONCILIATION_VARIANCE',
] as const;
export type HandymanFinancialReadStatus =
  (typeof HANDYMAN_FINANCIAL_READ_STATUSES)[number];
export type HandymanFinancialRecordedState =
  'NOT_RECORDED' | 'EARNED' | 'PAYABLE' |
  'INCLUDED_IN_SETTLEMENT' | 'SETTLED';

export type HandymanFinancialEntitlementCorrection = {
  id: string; entitlementId: string; ledgerCorrectionId: string;
  factKind: 'ADJUSTED_INCREASE' | 'ADJUSTED_DECREASE' | 'REVERSED';
  amount: string; actorUserId: string; occurredAt: string;
};
export type HandymanFinancialEntitlementFact = {
  id: string; clientId: string; transactionId: string;
  executionScopeId: string; currency: string;
  ledgerPostedAt: string; ledgerContractVersion: 'CR-HM-13-PART-06';
  entitlementKind: 'PROVIDER' | 'BM_FEE'; factState: 'EARNED';
  basisKind: 'TRANSACTION_NET_CHARGED' | 'LABOR_ONLY';
  chargedNet: string; laborNet: string; materialNet: string;
  adjustedTransactionScope: string; amount: string;
  provider: {
    assignmentId: string; providerContextId: string; crewId: string;
    leadWorkerId: string; leadUserId: string;
  } | null;
  bmFee: {
    agreementId: string; agreementVersionId: string;
    versionNumber: number; effectiveFrom: string; effectiveTo: string | null;
    ruleId: string; termId: string; ratePercent: string;
    beneficiaryId: string; beneficiaryReferenceId: string;
  } | null;
  derivedByUserId: string; derivedAt: string;
  /** Posted deltas are distinct facts; amount above is the immutable
   * originally earned amount, NOT silently re-netted or replaced. */
  corrections: HandymanFinancialEntitlementCorrection[];
};
export type HandymanFinancialSettlementEvent = {
  id: string; state: 'PAYABLE' | 'INCLUDED_IN_SETTLEMENT' | 'SETTLED';
  reconciliationId: string | null; actorUserId: string; occurredAt: string;
};
export type HandymanFinancialSettlementInclusion = {
  id: string; entitlementId: string; amount: string;
  actorUserId: string; occurredAt: string;
};
export type HandymanFinancialReconciliation = {
  id: string; sequence: string; ledgerContractVersion: 'CR-HM-13-PART-06';
  windowFrom: string; windowTo: string; currency: string;
  ledgerChargedNet: string; ledgerApplied: string; ledgerNetReceived: string;
  entitlementTotal: string; includedTotal: string;
  outcome: 'MATCHED' | 'VARIANCE';
  varianceCause: 'NONE' | 'INCLUSION_MISMATCH' |
    'LEDGER_BASIS_MISMATCH' | 'FUNDING_SHORTFALL' | 'OPEN_EXCEPTION';
  varianceAmount: string; actorUserId: string; occurredAt: string;
};
export type HandymanFinancialSettlementException = {
  id: string; exceptionKind: 'REVERSED' | 'ADJUSTED' | 'DISPUTED';
  ledgerCorrectionId: string | null; amount: string;
  actorUserId: string; occurredAt: string;
};
export type HandymanFinancialSettlementRead = {
  unitId: string; clientId: string; transactionId: string;
  executionScopeId: string; currency: string;
  createdByUserId: string; createdAt: string;
  /** This is a projection of posted events, never a writable status. */
  recordedState: Exclude<HandymanFinancialRecordedState, 'NOT_RECORDED' | 'EARNED'> |
    'NOT_RECORDED';
  events: HandymanFinancialSettlementEvent[];
  inclusions: HandymanFinancialSettlementInclusion[];
  reconciliations: HandymanFinancialReconciliation[];
  latestReconciliation: HandymanFinancialReconciliation | null;
  exceptions: HandymanFinancialSettlementException[];
};
export type HandymanFinancialNetBasis = {
  /** These fields are passed through from the published CR-HM-13 read. */
  chargedNet: string; laborNet: string; materialNet: string;
  applied: string; netReceived: string; outstanding: string;
};
export type HandymanFinancialTransactionRead = {
  contractVersion: typeof HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION;
  ledgerContractVersion: 'CR-HM-13-PART-06';
  readOnly: true;
  transaction: {
    transactionId: string; executionScopeId: string;
    clientId: string; currency: string; openedAt: string;
  };
  authority: HandymanLedgerReadAuthority;
  /** Informational posture; not permission to transition, settle or move funds. */
  status: HandymanFinancialReadStatus;
  netBasis: HandymanFinancialNetBasis;
  entitlements: HandymanFinancialEntitlementFact[];
  settlement: HandymanFinancialSettlementRead | null;
};
export type HandymanFinancialClientRead = {
  contractVersion: typeof HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION;
  ledgerContractVersion: 'CR-HM-13-PART-06';
  readOnly: true; clientId: string;
  from: string | null; to: string | null; limit: number;
  authority: HandymanLedgerReadAuthority & {
    nonAuthoritativeTransactionIds: string[];
  };
  /** Only per-ledger authoritative entries; no merged financial total. */
  transactions: HandymanFinancialTransactionRead[];
  excludedTransactionIds: string[];
};
export type ReadHandymanFinancialClientOptions =
  ReadHandymanLedgerClientBasisOptions;

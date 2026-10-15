/**
 * CR-HM-FIN-DISCOVERY-02 P0-B — Authoritative Finance Action Inbox types.
 *
 * All record types, statuses, blocker codes, and responsible permissions come
 * directly from the existing CR-HM-13 / CR-HM-14 / CR-HM-FIN-AUTH-01 modules
 * and database tables — never from fabricated workflow labels.
 */

export const HANDYMAN_FINANCE_ACTION_INBOX_RECORD_TYPES = [
  'CUSTOMER_PAYMENT',
  'LEDGER_CORRECTION',
  'SETTLEMENT_UNIT',
  'CUSTOMER_TRANSACTION',
] as const;

export type HandymanFinanceActionInboxRecordType =
  (typeof HANDYMAN_FINANCE_ACTION_INBOX_RECORD_TYPES)[number];

export const HANDYMAN_FINANCE_ACTION_INBOX_CATEGORIES = [
  'PAYMENT_VERIFICATION',
  'PAYMENT_ALLOCATION',
  'PENDING_CORRECTION',
  'PENDING_RECONCILIATION',
  'FINANCE_BLOCKER',
] as const;

export type HandymanFinanceActionInboxCategory =
  (typeof HANDYMAN_FINANCE_ACTION_INBOX_CATEGORIES)[number];

export const HANDYMAN_FINANCE_ACTION_INBOX_RECORD_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'REFUND',
  'REVERSAL',
  'ADJUSTMENT',
  'PAYABLE',
  'INCLUDED_IN_SETTLEMENT',
  'SETTLED',
  'LEDGER_ONLY',
] as const;

export type HandymanFinanceActionInboxRecordStatus =
  (typeof HANDYMAN_FINANCE_ACTION_INBOX_RECORD_STATUSES)[number];

export const HANDYMAN_FINANCE_ACTION_INBOX_BLOCKER_CODES = [
  'NO_POSTED_CHARGE_FACTS',
  'PROVISIONAL_PAYMENTS_PENDING',
  'FUNDING_SHORTFALL',
  'INCLUSION_MISMATCH',
  'LEDGER_BASIS_MISMATCH',
  'OPEN_EXCEPTION',
] as const;

export type HandymanFinanceActionInboxBlockerCode =
  (typeof HANDYMAN_FINANCE_ACTION_INBOX_BLOCKER_CODES)[number];

export const HANDYMAN_FINANCE_ACTION_INBOX_RESPONSIBLE_PERMISSIONS = [
  'handyman.finance.manage',
  'handyman.settlement.manage',
] as const;

export type HandymanFinanceActionInboxResponsiblePermission =
  (typeof HANDYMAN_FINANCE_ACTION_INBOX_RESPONSIBLE_PERMISSIONS)[number];

export const HANDYMAN_FINANCE_ACTION_INBOX_RESPONSIBLE_ACTIONS = [
  'VERIFY_CUSTOMER_PAYMENT',
  'ALLOCATE_CUSTOMER_PAYMENT',
  'COMPOSE_CHARGE_LINES',
  'PROPAGATE_ENTITLEMENT_CORRECTION',
  'RECORD_SETTLEMENT_CORRECTION',
  'INCLUDE_IN_SETTLEMENT',
  'RECONCILE_SETTLEMENT_UNIT',
  'SETTLE_SETTLEMENT_UNIT',
  'RESOLVE_FUNDING_SHORTFALL',
  'RESOLVE_SETTLEMENT_VARIANCE',
] as const;

export type HandymanFinanceActionInboxResponsibleAction =
  (typeof HANDYMAN_FINANCE_ACTION_INBOX_RESPONSIBLE_ACTIONS)[number];

export type HandymanFinanceActionInboxCursor = {
  createdAt: Date;
  recordType: HandymanFinanceActionInboxRecordType;
  recordId: string;
};

export type HandymanFinanceActionInboxQuery = {
  clientId: string;
  buildingId?: string;
  tenantCompanyId?: string;
  executionScopeId?: string;
  handymanRequestId?: string;
  transactionId?: string;
  recordType?: HandymanFinanceActionInboxRecordType;
  actionCategory?: HandymanFinanceActionInboxCategory;
  recordStatus?: HandymanFinanceActionInboxRecordStatus;
  blockerCode?: HandymanFinanceActionInboxBlockerCode;
  hasBlocker?: boolean;
  responsiblePermission?: HandymanFinanceActionInboxResponsiblePermission;
  createdFrom?: Date;
  createdTo?: Date;
  includeCounts?: boolean;
  limit: number;
  cursor?: HandymanFinanceActionInboxCursor;
};

export type HandymanFinanceActionInboxItem = {
  recordId: string;
  recordType: HandymanFinanceActionInboxRecordType;
  recordStatus: HandymanFinanceActionInboxRecordStatus;
  actionCategory: HandymanFinanceActionInboxCategory;
  blockerCode: HandymanFinanceActionInboxBlockerCode | null;
  executionScopeId: string;
  handymanRequestId: string;
  transactionId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  currency: string;
  amount: string;
  allocatedAmount: string | null;
  unallocatedAmount: string | null;
  allocationState: 'UNALLOCATED' | 'PARTIALLY_ALLOCATED' | null;
  responsible: {
    permission: HandymanFinanceActionInboxResponsiblePermission;
    action: HandymanFinanceActionInboxResponsibleAction;
  };
  provenance: {
    paymentId: string | null;
    paymentStatus: 'PENDING' | 'CONFIRMED' | null;
    paymentChannel: string | null;
    paymentReference: string | null;
    recordedByUserId: string | null;
    paymentProofEvidenceId: string | null;
    ledgerCorrectionId: string | null;
    correctionKind: 'REFUND' | 'REVERSAL' | 'ADJUSTMENT' | null;
    correctionSourceKind:
      | 'PAYMENT'
      | 'ALLOCATION'
      | 'CHARGE_LINE'
      | 'TRANSACTION'
      | null;
    entitlementCorrectionPending: boolean;
    settlementCorrectionPending: boolean;
    settlementUnitId: string | null;
    settlementState: 'PAYABLE' | 'INCLUDED_IN_SETTLEMENT' | 'SETTLED' | null;
    reconciliationId: string | null;
    reconciliationOutcome: 'MATCHED' | 'VARIANCE' | null;
    varianceCause:
      | 'NONE'
      | 'INCLUSION_MISMATCH'
      | 'LEDGER_BASIS_MISMATCH'
      | 'FUNDING_SHORTFALL'
      | 'OPEN_EXCEPTION'
      | null;
    varianceAmount: string | null;
    openExceptionCount: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type HandymanFinanceActionInboxCounts = {
  total: number;
  byActionCategory: Record<HandymanFinanceActionInboxCategory, number>;
  byRecordType: Record<HandymanFinanceActionInboxRecordType, number>;
  byRecordStatus: Partial<Record<HandymanFinanceActionInboxRecordStatus, number>>;
  byBlockerCode: Partial<Record<HandymanFinanceActionInboxBlockerCode, number>>;
  byResponsiblePermission: Record<
    HandymanFinanceActionInboxResponsiblePermission,
    number
  >;
};

export type HandymanFinanceActionInboxResult = {
  items: HandymanFinanceActionInboxItem[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
  counts?: HandymanFinanceActionInboxCounts;
};

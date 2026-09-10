import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementFinancialSummaryQuery = {
  scope: ManagementReadScopeFilters;
};

/**
 * Amount is null when BE-19I cannot represent the aggregate as a single
 * amount under its single-currency convenience rule (multi-currency or
 * unknown-currency source data). Null is propagated, never zero-filled:
 * an unavailable total must not be reported as 0.
 */
export type ManagementCountAmount = { count: number; amount: number | null };

export type ManagementFinancialSummaryBlock = {
  tenantCharges: ManagementCountAmount & { cancelledCount: number };
  utilityBills: ManagementCountAmount & { cancelledCount: number };
  invoices: ManagementCountAmount & {
    draftCount: number;
    cancelledCount: number;
  };
  payments: {
    paidAmount: number | null;
    unpaidAmount: number | null;
    overdueAmount: number | null;
    outstandingAmount: number | null;
    unpaidCount: number;
    partiallyPaidCount: number;
    paidCount: number;
    overdueCount: number;
  };
  receipts: {
    issued: ManagementCountAmount;
    void: ManagementCountAmount;
  };
  vendorServiceCosts: {
    finalized: ManagementCountAmount;
    draftCount: number;
    cancelledCount: number;
  };
  basicExpenses: {
    finalized: ManagementCountAmount;
    draftCount: number;
    cancelledCount: number;
  };
  outstandingBalance: { invoiceCount: number; amount: number | null };
  incomeVsOperationalCost: {
    billedIncome: number | null;
    receivedIncome: number | null;
    operationalCost: number | null;
    netBilled: number | null;
    netReceived: number | null;
  };
};

export type ManagementBuildingFinancialSummary = {
  clientId: string;
  buildingId: string;
  summary: ManagementFinancialSummaryBlock;
};

export type ManagementClientFinancialSummary = {
  clientId: string;
  buildingIds: string[];
  /** Additive roll-up of authoritative BE-19I Building summaries. */
  summary: ManagementFinancialSummaryBlock;
};

export type ManagementFinancialSummaryData = {
  /** Money is never summed across Clients because BE-19 has no currency field. */
  clientSummaries: ManagementClientFinancialSummary[];
  buildingSummaries: ManagementBuildingFinancialSummary[];
};

export type PublicManagementFinancialSummary = ManagementReadModelContract<
  ManagementFinancialSummaryData
>;

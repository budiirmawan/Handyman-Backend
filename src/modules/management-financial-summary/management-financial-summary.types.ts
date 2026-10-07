import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementFinancialSummaryQuery = {
  scope: ManagementReadScopeFilters;
};

export type ManagementCountAmount = { count: number; amount: number | null };

/**
 * BE-19I legacy scalars are nullable per the single-currency rule: an amount
 * is null when it is not attributable to exactly one currency
 * (multi-currency or unknown rows present). Client roll-ups propagate null
 * rather than summing unattributable money — counts stay additive.
 */
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

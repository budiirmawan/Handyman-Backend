import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementFinancialSummaryQuery = {
  scope: ManagementReadScopeFilters;
};

export type ManagementCountAmount = { count: number; amount: number };

export type ManagementFinancialSummaryBlock = {
  tenantCharges: ManagementCountAmount & { cancelledCount: number };
  utilityBills: ManagementCountAmount & { cancelledCount: number };
  invoices: ManagementCountAmount & {
    draftCount: number;
    cancelledCount: number;
  };
  payments: {
    paidAmount: number;
    unpaidAmount: number;
    overdueAmount: number;
    outstandingAmount: number;
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
  outstandingBalance: { invoiceCount: number; amount: number };
  incomeVsOperationalCost: {
    billedIncome: number;
    receivedIncome: number;
    operationalCost: number;
    netBilled: number;
    netReceived: number;
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

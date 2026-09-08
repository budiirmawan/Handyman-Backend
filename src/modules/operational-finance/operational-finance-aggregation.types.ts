import type {
  OperationalBudgetCurrency,
  OperationalBudgetPeriod,
  OperationalBudgetStatus,
  OperationalFinanceSourceType,
} from './operational-finance.types';

export type OperationalFinanceAggregationSourceRow = {
  bindingId: string;
  budgetCategoryId: string;
  sourceType: OperationalFinanceSourceType;
  sourceId: string;
  sourceAmount: string | null;
  sourceCurrency: string | null;
  sourceDate: string | null;
  sourceStatus: string | null;
  sourceVerificationStatus: string | null;
  bindingCurrencyStatus: 'MATCHED' | 'MISSING';
  purchaseOrderIds: string[];
  sourceCostId: string | null;
  sourceVendorWorkId: string | null;
  sourceWorkOrderId: string | null;
};

export type OperationalBudgetAggregationRow = {
  budgetCategoryId: string;
  categoryCode: string;
  categoryName: string;
  plannedAmount: number;
  actualAmount: number;
  committedAmount: number;
  remainingAmount: number;
  varianceAmount: number;
  actualSourceCount: number;
  committedSourceCount: number;
};

export type OperationalBudgetAggregationExclusion = {
  bindingId: string;
  budgetCategoryId: string;
  sourceType: OperationalFinanceSourceType;
  sourceId: string;
  reason:
    | 'SOURCE_NOT_ELIGIBLE'
    | 'SOURCE_CURRENCY_UNPROVEN'
    | 'SOURCE_CURRENCY_MISMATCH'
    | 'SOURCE_PERIOD_OUTSIDE_BUDGET'
    | 'SOURCE_AMOUNT_UNAVAILABLE'
    | 'SOURCE_LINEAGE_AMBIGUOUS'
    | 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL'
    | 'PO_HEADER_SUPERSEDED_BY_PO_LINE'
    | 'PO_COMMITMENT_REPLACED_BY_ACTUAL';
};

export type PublicOperationalBudgetAggregation = {
  budgetId: string;
  clientId: string;
  budgetName: string;
  buildingId: string;
  budgetPeriod: OperationalBudgetPeriod;
  currency: OperationalBudgetCurrency;
  status: OperationalBudgetStatus;
  totals: {
    plannedAmount: number;
    actualAmount: number;
    committedAmount: number;
    remainingAmount: number;
    varianceAmount: number;
  };
  categories: OperationalBudgetAggregationRow[];
  controls: {
    failClosed: boolean;
    excludedContributionCount: number;
    exclusions: OperationalBudgetAggregationExclusion[];
  };
  asOf: string;
};

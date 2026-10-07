import type { ManagementReadModelContract } from '../management-read-scope';
import type { OperationalBudgetAggregationExclusion } from '../operational-finance';

export type ManagementOperationalFinanceControls = {
  failClosed: boolean;
  excludedContributionCount: number;
  exclusionReasons: OperationalBudgetAggregationExclusion['reason'][];
};

export type ManagementOperationalBudgetSummaryData = {
  budgetId: string;
  clientId: string;
  buildingId: string;
  budgetName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: string;
  totals: {
    plannedAmount: number;
    actualAmount: number;
    committedAmount: number;
    remainingAmount: number;
    varianceAmount: number;
  };
  controls: ManagementOperationalFinanceControls;
};

export type ManagementOperationalBudgetCategoryRow = {
  categoryId: string;
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

export type ManagementOperationalBudgetCategoriesData = {
  budgetId: string;
  clientId: string;
  buildingId: string;
  budgetName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: string;
  categories: ManagementOperationalBudgetCategoryRow[];
  controls: ManagementOperationalFinanceControls;
};

export type PublicManagementOperationalBudgetSummary =
  ManagementReadModelContract<
    ManagementOperationalBudgetSummaryData,
    { budgetId: string }
  >;

export type PublicManagementOperationalBudgetCategories =
  ManagementReadModelContract<
    ManagementOperationalBudgetCategoriesData,
    { budgetId: string }
  >;

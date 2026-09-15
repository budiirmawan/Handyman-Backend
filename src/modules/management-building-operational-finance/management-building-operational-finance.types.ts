import type { ManagementReadModelContract } from '../management-read-scope';

export type ManagementBuildingOperationalFinanceCategory = {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  plannedAmount: number;
  actualAmount: number;
  committedAmount: number;
  remainingAmount: number;
  varianceAmount: number;
  budgetUtilizationPercent: number | null;
};

export type ManagementBuildingOperationalFinanceData = {
  clientId: string;
  buildingId: string;
  periodStart: string;
  periodEnd: string;
  currency: string | null;
  plannedAmount: number;
  actualAmount: number;
  committedAmount: number;
  remainingAmount: number;
  varianceAmount: number;
  activeBudgetCount: number;
  categoryCount: number;
  categoriesOverBudget: number;
  categoriesWithCommitment: number;
  failClosed: boolean;
  excludedContributionCount: number;
  exclusionReasons: string[];
  categories: ManagementBuildingOperationalFinanceCategory[];
};

export type ManagementBuildingOperationalFinanceFilters = {
  buildingId: string;
  periodStart: string;
  periodEnd: string;
};

export type PublicManagementBuildingOperationalFinance =
  ManagementReadModelContract<
    ManagementBuildingOperationalFinanceData,
    ManagementBuildingOperationalFinanceFilters
  >;

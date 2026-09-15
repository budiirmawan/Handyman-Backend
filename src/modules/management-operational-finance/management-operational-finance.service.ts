import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { operationalFinanceAggregationService } from '../operational-finance/operational-finance-aggregation.service';
import type { PublicOperationalBudgetAggregation } from '../operational-finance/operational-finance-aggregation.types';
import type {
  ManagementOperationalBudgetCategoriesData,
  ManagementOperationalBudgetSummaryData,
  ManagementOperationalFinanceControls,
  PublicManagementOperationalBudgetCategories,
  PublicManagementOperationalBudgetSummary,
} from './management-operational-finance.types';

function controls(
  aggregation: PublicOperationalBudgetAggregation,
): ManagementOperationalFinanceControls {
  return {
    failClosed: aggregation.controls.failClosed,
    excludedContributionCount: aggregation.controls.excludedContributionCount,
    exclusionReasons: [
      ...new Set(aggregation.controls.exclusions.map((entry) => entry.reason)),
    ].sort(),
  };
}

function common(aggregation: PublicOperationalBudgetAggregation) {
  return {
    budgetId: aggregation.budgetId,
    clientId: aggregation.clientId,
    buildingId: aggregation.buildingId,
    budgetName: aggregation.budgetName,
    periodStart: aggregation.budgetPeriod.start,
    periodEnd: aggregation.budgetPeriod.end,
    currency: aggregation.currency,
    status: aggregation.status,
  };
}

async function resolve(
  budgetId: string,
  userId: string,
): Promise<{
  aggregation: PublicOperationalBudgetAggregation;
  scope: Awaited<ReturnType<typeof resolveManagementReadScope>>;
}> {
  const aggregation =
    await operationalFinanceAggregationService.getOperationalBudgetAggregation(
      budgetId,
      userId,
    );
  const scope = await resolveManagementReadScope(
    { buildingId: aggregation.buildingId },
    userId,
  );
  return { aggregation, scope };
}

export async function getManagementOperationalBudgetSummary(
  budgetId: string,
  userId: string,
): Promise<PublicManagementOperationalBudgetSummary> {
  const { aggregation, scope } = await resolve(budgetId, userId);
  const data: ManagementOperationalBudgetSummaryData = {
    ...common(aggregation),
    totals: aggregation.totals,
    controls: controls(aggregation),
  };
  return createManagementReadModelContract(
    scope.context,
    { budgetId },
    data,
  );
}

export async function getManagementOperationalBudgetCategories(
  budgetId: string,
  userId: string,
): Promise<PublicManagementOperationalBudgetCategories> {
  const { aggregation, scope } = await resolve(budgetId, userId);
  const data: ManagementOperationalBudgetCategoriesData = {
    ...common(aggregation),
    categories: aggregation.categories.map((category) => ({
      categoryId: category.budgetCategoryId,
      categoryCode: category.categoryCode,
      categoryName: category.categoryName,
      plannedAmount: category.plannedAmount,
      actualAmount: category.actualAmount,
      committedAmount: category.committedAmount,
      remainingAmount: category.remainingAmount,
      varianceAmount: category.varianceAmount,
      actualSourceCount: category.actualSourceCount,
      committedSourceCount: category.committedSourceCount,
    })),
    controls: controls(aggregation),
  };
  return createManagementReadModelContract(
    scope.context,
    { budgetId },
    data,
  );
}

export const managementOperationalFinanceService = {
  getManagementOperationalBudgetCategories,
  getManagementOperationalBudgetSummary,
};
